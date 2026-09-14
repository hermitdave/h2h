#ifndef NEX_TASK_SCHEDULER_HPP
#define NEX_TASK_SCHEDULER_HPP

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <mutex>
#include <optional>
#include <queue>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace nex {

using task_id_t = std::uint64_t;
using clock_time_point = std::chrono::steady_clock::time_point;

class Clock {
public:
    virtual ~Clock() = default;
    virtual clock_time_point now() const noexcept = 0;
};

class DefaultClock final : public Clock {
public:
    static DefaultClock& instance() noexcept {
        static DefaultClock clock;
        return clock;
    }

    clock_time_point now() const noexcept override {
        return std::chrono::steady_clock::now();
    }
};

class TaskUpdateError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

class UnknownTaskError final : public TaskUpdateError {
public:
    explicit UnknownTaskError(const std::string& message)
        : std::runtime_error(message) {}
};

class TaskExistsError final : public TaskUpdateError {
public:
    explicit TaskExistsError(const std::string& message)
        : std::runtime_error(message) {}
};

class InvalidTaskStateError final : public TaskUpdateError {
public:
    explicit InvalidTaskStateError(const std::string& message)
        : std::runtime_error(message) {}
};

class ClaimMismatchError final : public InvalidTaskStateError {
public:
    explicit ClaimMismatchError(const std::string& message)
        : InvalidTaskStateError(message) {}
};

class DependencyCycleError final : public TaskUpdateError {
public:
    explicit DependencyCycleError()
        : std::runtime_error("dependency update creates a cycle") {}
};

class CapacityError final : public TaskUpdateError {
public:
    CapacityError(std::size_t capacity, std::size_t required)
        : std::runtime_error(
              "task scheduler capacity exceeded: " +
              std::to_string(capacity) + " capacity, " +
              std::to_string(required) + " required") {}
};

enum class TaskState {
    Pending,
    Ready,
    Running,
    Succeeded,
    Failed,
    Cancelled
};

enum class FailurePolicy {
    Block,
    MarkDependentSuccess
};

struct Task {
    task_id_t task_id = 0;
    int priority = 0;
    clock_time_point ready_at = clock_time_point::min();
    std::vector<task_id_t> dependencies;

    Task() = default;

    Task(task_id_t task_id,
         int priority,
         clock_time_point ready_at,
         std::vector<task_id_t> dependencies = {})
        : task_id(task_id)
        , priority(priority)
        , ready_at(ready_at)
        , dependencies(std::move(dependencies)) {
        dependencies.erase(
            std::unique(dependencies.begin(), dependencies.end()),
            dependencies.end());
        if (std::find(dependencies.begin(), dependencies.end(), task_id) !=
            dependencies.end()) {
            throw TaskUpdateError("task cannot depend on itself");
        }
    }
};

struct TaskChanges {
    std::optional<int> priority;
    std::optional<clock_time_point> ready_at;
    std::optional<std::vector<task_id_t>> dependencies;
    std::optional<std::uint64_t> expected_revision;
};

struct TaskRecord {
    task_id_t task_id = 0;
    int priority = 0;
    clock_time_point ready_at = clock_time_point::min();
    std::vector<task_id_t> dependencies;
    TaskState state = TaskState::Pending;
    std::uint64_t revision = 0;
    std::size_t pending_dependencies = 0;
    std::uint64_t claim_token = 0;

    clock_time_point execution_timestamp() const noexcept {
        return ready_at;
    }

    std::uint64_t generation() const noexcept {
        return revision;
    }

    std::optional<std::uint64_t> claim_id() const noexcept {
        return claim_token == 0
                   ? std::nullopt
                   : std::optional<std::uint64_t>(claim_token);
    }
};

struct TaskHandle {
    task_id_t task_id = 0;
    std::uint64_t lease_token = 0;

    task_id_t id() const noexcept {
        return task_id;
    }

    std::uint64_t token() const noexcept {
        return lease_token;
    }
};

class TaskScheduler {
public:
    static constexpr std::size_t default_capacity = 1'000'000;

    explicit TaskScheduler(std::size_t max_tasks = default_capacity,
                           const Clock* clock = nullptr,
                           bool allow_cycles = false)
        : max_tasks_(max_tasks)
        , clock_(clock)
        , allow_cycles_(allow_cycles) {
        entries_.reserve(max_tasks_);
        id_to_index_.reserve(max_tasks_);
        dependents_.reserve(max_tasks_);
    }

    TaskScheduler(const TaskScheduler&) = delete;
    TaskScheduler& operator=(const TaskScheduler&) = delete;
    TaskScheduler(TaskScheduler&&) = delete;
    TaskScheduler& operator=(TaskScheduler&&) = delete;

    [[nodiscard]] std::size_t task_count() const noexcept {
        std::lock_guard<std::mutex> lock(mutex_);
        return entries_.size();
    }

    [[nodiscard]] std::size_t ready_task_count() const noexcept {
        std::lock_guard<std::mutex> lock(mutex_);
        return ready_count_;
    }

    [[nodiscard]] std::size_t pending_task_count() const noexcept {
        std::lock_guard<std::mutex> lock(mutex_);
        return entries_.size() - ready_count_;
    }

    [[nodiscard]] std::size_t capacity() const noexcept {
        return max_tasks_;
    }

    [[nodiscard]] clock_time_point now() const noexcept {
        return clock()->now();
    }

    [[nodiscard]] TaskRecord add(const Task& task) {
        return register_task(task);
    }

    [[nodiscard]] TaskRecord register_task(const Task& task) {
        std::lock_guard<std::mutex> lock(mutex_);
        const std::vector<Task> submitted{task};
        _register_tasks_locked(submitted);
        return get_task_record(task.task_id);
    }

    void register_tasks(const std::vector<Task>& submitted) {
        std::lock_guard<std::mutex> lock(mutex_);
        _register_tasks_locked(submitted);
    }

    void register_tasks(std::initializer_list<Task> submitted) {
        register_tasks(std::vector<Task>(submitted));
    }

    [[nodiscard]] TaskRecord update_task(const task_id_t task_id,
                                         const TaskChanges& changes) {
        std::lock_guard<std::mutex> lock(mutex_);
        return _update_tasks_locked({{task_id, changes}}).at(task_id);
    }

    [[nodiscard]] std::unordered_map<task_id_t, TaskRecord> update_tasks(
        const std::unordered_map<task_id_t, TaskChanges>& changes) {
        std::lock_guard<std::mutex> lock(mutex_);
        return _update_tasks_locked(changes);
    }

    [[nodiscard]] std::optional<TaskRecord> peek_next() {
        std::lock_guard<std::mutex> lock(mutex_);
        _promote_due_locked();
        if (ready_count_ == 0 || ready_heap_.empty()) {
            return std::nullopt;
        }
        const auto top = ready_heap_.top_entry();
        const auto& task = entries_.at(top.task_index);
        if (!ready_heap_.contains(top.task_index, top.revision) ||
            task.state != TaskState::Ready) {
            return std::nullopt;
        }
        return _snapshot(task);
    }

    [[nodiscard]] std::optional<TaskHandle> next_task() {
        auto claims = claim_next(1);
        return claims.empty()
                   ? std::optional<TaskHandle>()
                   : std::optional<TaskHandle>(std::move(claims.front()));
    }

    [[nodiscard]] std::vector<TaskHandle> claim_next(std::size_t count) {
        std::lock_guard<std::mutex> lock(mutex_);
        _promote_due_locked();
        std::vector<TaskHandle> result;
        result.reserve(std::min(count, ready_count_));

        while (result.size() < count && ready_count_ > 0) {
            const auto heap_entry = ready_heap_.pop();
            const auto index = heap_entry.task_index;
            if (index >= entries_.size()) {
                throw std::logic_error("ready heap contains an invalid task index");
            }
            auto& task = entries_[index];
            if (task.revision != heap_entry.revision ||
                task.state != TaskState::Ready ||
                task.pending_dependencies != 0) {
                continue;
            }
            task.state = TaskState::Running;
            task.claim_token = ++lease_counter_;
            --ready_count_;
            result.push_back({task.task_id, task.claim_token});
        }
        return result;
    }

    [[nodiscard]] TaskRecord complete(const TaskHandle& lease) {
        std::lock_guard<std::mutex> lock(mutex_);
        const auto index = _require_index_locked(lease.task_id);
        auto& task = entries_[index];
        _validate_lease(task, lease.task_id, lease.lease_token);
        task.state = TaskState::Succeeded;
        task.claim_token = 0;
        _successors_of_completed(task.task_id, false);
        _condition.notify_all();
        return _snapshot(task);
    }

    [[nodiscard]] TaskRecord fail(const TaskHandle& lease,
                                  FailurePolicy policy = FailurePolicy::Block) {
        std::lock_guard<std::mutex> lock(mutex_);
        const auto index = _require_index_locked(lease.task_id);
        auto& task = entries_[index];
        _validate_lease(task, lease.task_id, lease.lease_token);
        task.state = TaskState::Failed;
        task.claim_token = 0;
        _successors_of_completed(task.task_id,
                                 policy == FailurePolicy::MarkDependentSuccess);
        _condition.notify_all();
        return _snapshot(task);
    }

    [[nodiscard]] TaskRecord retry(const TaskHandle& lease,
                                   std::optional<clock_time_point> ready_at = std::nullopt) {
        std::lock_guard<std::mutex> lock(mutex_);
        const auto index = _require_index_locked(lease.task_id);
        auto& task = entries_[index];
        _validate_lease(task, lease.task_id, lease.lease_token);
        if (task.state != TaskState::Running) {
            throw InvalidTaskStateError("only running tasks can be retried");
        }
        if (ready_at.has_value()) {
            task.ready_at = *ready_at;
        }
        task.state = TaskState::Pending;
        task.claim_token = 0;
        ++task.revision;
        _set_pending_locked(task, false, clock_time_point{});
        _condition.notify_all();
        return _snapshot(task);
    }

    [[nodiscard]] TaskRecord retry_failed(const task_id_t task_id,
                                          std::optional<clock_time_point> ready_at = std::nullopt) {
        std::lock_guard<std::mutex> lock(mutex_);
        const auto index = _require_index_locked(task_id);
        auto& task = entries_[index];
        if (task.state != TaskState::Failed) {
            throw InvalidTaskStateError("only failed tasks can be retried");
        }
        if (ready_at.has_value()) {
            task.ready_at = *ready_at;
        }
        task.state = TaskState::Pending;
        task.claim_token = 0;
        ++task.revision;
        _set_pending_locked(task, false, clock_time_point{});
        _condition.notify_all();
        return _snapshot(task);
    }

    [[nodiscard]] std::optional<TaskRecord> replace_dependencies(
        const task_id_t task_id, std::vector<task_id_t> dependencies) {
        TaskChanges changes;
        changes.dependencies = std::move(dependencies);
        std::lock_guard<std::mutex> lock(mutex_);
        auto result = _update_tasks_locked({{task_id, changes}});
        const auto found = result.find(task_id);
        return found == result.end()
                   ? std::nullopt
                   : std::optional<TaskRecord>(std::move(found->second));
    }

    [[nodiscard]] std::optional<TaskRecord> update_ready_at(
        const task_id_t task_id, clock_time_point ready_at) {
        TaskChanges changes;
        changes.ready_at = ready_at;
        std::lock_guard<std::mutex> lock(mutex_);
        auto result = _update_tasks_locked({{task_id, changes}});
        return result.find(task_id) == result.end()
                   ? std::nullopt
                   : std::optional<TaskRecord>(std::move(result.at(task_id)));
    }

    [[nodiscard]] std::optional<TaskRecord> update_priority(
        const task_id_t task_id, int priority) {
        TaskChanges changes;
        changes.priority = priority;
        std::lock_guard<std::mutex> lock(mutex_);
        auto result = _update_tasks_locked({{task_id, changes}});
        return result.find(task_id) == result.end()
                   ? std::nullopt
                   : std::optional<TaskRecord>(std::move(result.at(task_id)));
    }

    [[nodiscard]] bool would_create_cycle(const task_id_t task_id,
                                          std::vector<task_id_t> dependencies) const {
        TaskChanges changes;
        changes.dependencies = std::move(dependencies);
        std::lock_guard<std::mutex> lock(mutex_);
        _require_index_locked(task_id);
        return _has_cycle_all_locked(_candidate_dependents_locked({{task_id, changes}}));
    }

    [[nodiscard]] bool has_cycle() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return _has_cycle_all_locked(_candidate_dependents_locked({}));
    }

    [[nodiscard]] std::optional<std::vector<task_id_t>> find_cycle(
        const task_id_t task_id) const {
        std::lock_guard<std::mutex> lock(mutex_);
        _require_index_locked(task_id);
        return _find_cycle_from_locked(_candidate_dependents_locked({}));
    }

    [[nodiscard]] TaskRecord get_task_record(const task_id_t task_id) const {
        std::lock_guard<std::mutex> lock(mutex_);
        return _snapshot(entries_.at(_require_index_locked(task_id)));
    }

    [[nodiscard]] bool cancel(const task_id_t task_id) {
        std::lock_guard<std::mutex> lock(mutex_);
        const auto index = _require_index_locked(task_id);
        auto& task = entries_[index];
        if (task.state == TaskState::Cancelled ||
            task.state == TaskState::Succeeded) {
            return false;
        }
        if (task.state == TaskState::Running) {
            throw InvalidTaskStateError("running tasks cannot be cancelled");
        }
        const bool was_ready = task.state == TaskState::Ready;
        _remove_from_index_locked(task);
        task.state = TaskState::Cancelled;
        if (was_ready) {
            --ready_count_;
        }
        _condition.notify_all();
        return true;
    }

    template <typename Rep, typename Period>
    bool wait_for_next(const std::chrono::duration<Rep, Period>& timeout) {
        if (timeout < std::chrono::duration<Rep, Period>{std::chrono::duration<Rep, Period>::zero()}) {
            throw std::invalid_argument("timeout must be non-negative");
        }
        const auto deadline = clock()->now() + timeout;
        std::unique_lock<std::mutex> lock(mutex_);
        while (true) {
            _promote_due_locked();
            if (ready_count_ > 0) {
                return true;
            }
            if (clock()->now() >= deadline) {
                return false;
            }
            if (!due_heap_.empty() && due_heap_.top_entry().ready_at > clock()->now()) {
                const auto next_due = due_heap_.top_entry().ready_at;
                const auto wait_end = next_due < deadline ? next_due : deadline;
                condition_.wait_until(lock, wait_end);
                continue;
            }
            condition_.wait_until(lock, deadline);
        }
    }

    void assert_invariants() const {
        std::lock_guard<std::mutex> lock(mutex_);
        if (entries_.size() != id_to_index_.size() ||
            entries_.size() != dependents_.size()) {
            throw std::runtime_error("task and adjacency maps have inconsistent sizes");
        }
        if (ready_count_ != ready_heap_.size()) {
            throw std::runtime_error("ready count does not equal ready index size");
        }

        std::size_t ready = 0;
        std::size_t blocked = 0;
        for (std::size_t index = 0; index < entries_.size(); ++index) {
            const auto& task = entries_[index];
            switch (task.state) {
                case TaskState::Pending:
                    if (task.pending_dependencies == 0) {
                        if (task.ready_at > clock()->now() ||
                            !due_heap_.contains(index, task.revision)) {
                            throw std::runtime_error("due task has no due entry");
                        }
                    } else {
                        ++blocked;
                        if (ready_heap_.contains(index, task.revision) ||
                            due_heap_.contains(index, task.revision)) {
                            throw std::runtime_error("blocked task has an executable index");
                        }
                    }
                    break;
                case TaskState::Blocked:
                    ++blocked;
                    if (ready_heap_.contains(index, task.revision) ||
                        due_heap_.contains(index, task.revision)) {
                        throw std::runtime_error("blocked task has an executable index");
                    }
                    break;
                case TaskState::Ready:
                    ++ready;
                    if (task.pending_dependencies != 0 ||
                        task.ready_at > clock()->now() ||
                        !ready_heap_.contains(index, task.revision) ||
                        ready_heap_.top_entry().task_index != index ||
                        ready_heap_.top_entry().revision != task.revision) {
                        throw std::runtime_error("ready task index invariant violation");
                    }
                    break;
                case TaskState::Running:
                case TaskState::Succeeded:
                case TaskState::Failed:
                case TaskState::Cancelled:
                    if (ready_heap_.contains(index, task.revision) ||
                        due_heap_.contains(index, task.revision)) {
                        throw std::runtime_error("terminal task has an executable index");
                    }
                    break;
            }
        }
        if (ready != ready_count_) {
            throw std::runtime_error("ready count invariant violation");
        }
    }

private:
    struct Entry {
        task_id_t task_id = 0;
        int priority = 0;
        clock_time_point ready_at = clock_time_point::min();
        std::vector<task_id_t> dependencies;
        TaskState state = TaskState::Pending;
        std::uint64_t revision = 0;
        std::size_t pending_dependencies = 0;
        std::uint64_t claim_token = 0;
    };

    struct HeapEntry {
        clock_time_point ready_at = clock_time_point::min();
        int priority = 0;
        std::uint64_t sequence = 0;
        std::size_t task_index = 0;
        std::uint64_t revision = 0;
    };

    struct ReadyLess {
        bool operator()(const HeapEntry& left,
                        const HeapEntry& right) const noexcept {
            if (left.ready_at != right.ready_at) {
                return left.ready_at > right.ready_at;
            }
            if (left.priority != right.priority) {
                return left.priority < right.priority;
            }
            return left.sequence > right.sequence;
        }
    };

    struct DueLess {
        bool operator()(const HeapEntry& left,
                        const HeapEntry& right) const noexcept {
            return left.ready_at > right.ready_at;
        }
    };

    template <typename Less = ReadyLess>
    class IndexHeap {
    public:
        explicit IndexHeap() = default;

        void push(const HeapEntry& entry) {
            if (entry.task_index >= locations_.size()) {
                locations_.resize(entry.task_index + 1, kNoLocation);
            }
            if (locations_[entry.task_index] != kNoLocation) {
                throw std::logic_error("task already has a live heap entry");
            }
            const auto location = data_.size();
            locations_[entry.task_index] = location;
            data_.push_back(entry);
            sift_up(location);
        }

        HeapEntry pop() {
            if (data_.empty()) {
                throw std::out_of_range("pop from empty heap");
            }
            const auto removed = data_.front();
            erase_at(0);
            return removed;
        }

        HeapEntry top_entry() const noexcept {
            if (data_.empty()) {
                throw std::out_of_range("top from empty heap");
            }
            return data_.front();
        }

        bool contains(std::size_t task_index,
                      std::uint64_t revision) const noexcept {
            if (task_index >= locations_.size()) {
                return false;
            }
            const auto location = locations_[task_index];
            return location != kNoLocation &&
                   data_[location].revision == revision;
        }

        bool erase(const HeapEntry& entry) {
            const auto location = get_location(entry.task_index);
            if (location == kNoLocation ||
                data_[location].revision != entry.revision) {
                return false;
            }
            erase_at(location);
            return true;
        }

        bool erase_task(std::size_t task_index) {
            const auto location = get_location(task_index);
            if (location == kNoLocation) {
                return false;
            }
            erase_at(location);
            return true;
        }

        std::size_t size() const noexcept {
            return data_.size();
        }

        bool empty() const noexcept {
            return data_.empty();
        }

    private:
        static constexpr std::size_t kNoLocation =
            static_cast<std::size_t>(-1);

        std::vector<HeapEntry> data_;
        std::vector<std::size_t> locations_;
        Less less_;

        std::size_t get_location(std::size_t task_index) const noexcept {
            if (task_index >= locations_.size()) {
                return kNoLocation;
            }
            return locations_[task_index];
        }

        void sift_up(std::size_t index) {
            while (index > 0) {
                const auto parent = (index - 1) / 2;
                if (!less_(data_[index], data_[parent])) {
                    break;
                }
                std::swap(data_[index], data_[parent]);
                locations_[data_[index].task_index] = index;
                locations_[data_[parent].task_index] = parent;
                index = parent;
            }
        }

        void sift_down(std::size_t index) {
            while (true) {
                const auto left = index * 2 + 1;
                if (left >= data_.size()) {
                    break;
                }
                const auto right = left + 1;
                const auto child = right < data_.size() &&
                                           less_(data_[right], data_[left])
                                       ? right
                                       : left;
                if (!less_(data_[child], data_[index])) {
                    break;
                }
                std::swap(data_[index], data_[child]);
                locations_[data_[index].task_index] = index;
                locations_[data_[child].task_index] = child;
                index = child;
            }
        }

        void erase_at(std::size_t index) {
            const auto removed = data_[index];
            const auto last_index = data_.size() - 1;
            if (index != last_index) {
                data_[index] = data_[last_index];
                locations_[data_[index].task_index] = index;
                locations_[removed.task_index] = last_index;
                const auto parent = index / 2;
                if (index > 0 && less_(data_[index], data_[parent])) {
                    sift_up(index);
                } else {
                    sift_down(index);
                }
            }
            data_.pop_back();
            locations_[removed.task_index] = kNoLocation;
        }
    };

    const Clock* clock() const noexcept {
        return clock_ ? clock_ : &DefaultClock::instance();
    }

    [[nodiscard]] std::size_t _require_index_locked(
        const task_id_t task_id) const {
        const auto it = id_to_index_.find(task_id);
        if (it == id_to_index_.end()) {
            throw UnknownTaskError("unknown task id");
        }
        return it->second;
    }

    [[nodiscard]] std::size_t _index_for_locked(const task_id_t task_id) const {
        return _require_index_locked(task_id);
    }

    [[nodiscard]] std::vector<std::vector<std::size_t>> _candidate_dependents_locked(
        const std::unordered_map<task_id_t, TaskChanges>& changes) const {
        std::vector<std::vector<std::size_t>> dependents(entries_.size());
        for (std::size_t index = 0; index < entries_.size(); ++index) {
            dependents[index].reserve(entries_[index].dependencies.size());
            for (const auto dependency : entries_[index].dependencies) {
                dependents[_index_for_locked(dependency)].push_back(index);
            }
        }
        for (const auto& [task_id, change] : changes) {
            const auto index = _index_for_locked(task_id);
            if (!change.dependencies.has_value()) {
                continue;
            }
            for (const auto dependency : entries_[index].dependencies) {
                auto& old = dependents[_index_for_locked(dependency)];
                old.erase(std::remove(old.begin(), old.end(), index), old.end());
            }
            for (const auto dependency : *change.dependencies) {
                dependents[_index_for_locked(dependency)].push_back(index);
            }
        }
        return dependents;
    }

    void _register_tasks_locked(const std::vector<Task>& submitted) {
        _validate_capacity_locked(entries_.size() + submitted.size());
        std::unordered_set<task_id_t> all_ids;
        all_ids.reserve(entries_.size() + submitted.size());
        for (const auto& entry : entries_) {
            all_ids.insert(entry.task_id);
        }

        std::unordered_map<task_id_t, std::size_t> new_indices;
        new_indices.reserve(submitted.size());
        for (const auto& task : submitted) {
            if (all_ids.find(task.task_id) != all_ids.end()) {
                throw TaskExistsError("duplicate task id in registration batch");
            }
            _validate_dependencies_locked(task.dependencies, all_ids, new_indices);
            new_indices[task.task_id] = old_size_locked() + new_indices.size();
            all_ids.insert(task.task_id);
        }

        std::unordered_map<task_id_t, std::vector<task_id_t>> overrides;
        overrides.reserve(submitted.size());
        for (const auto& task : submitted) {
            overrides[task.task_id] = task.dependencies;
        }
        const auto graph = _candidate_dependents_locked(overrides, &new_indices);
        if (!allow_cycles_ && _has_cycle_all_locked(graph)) {
            throw DependencyCycleError();
        }

        for (const auto& task : submitted) {
            const auto index = new_indices.at(task.task_id);
            entries_.push_back(Entry{task.task_id,
                                     task.priority,
                                     task.ready_at,
                                     task.dependencies,
                                     TaskState::Pending,
                                     0,
                                     0,
                                     0});
            id_to_index_[task.task_id] = index;
            dependents_.push_back({});
        }

        for (const auto& task : submitted) {
            const auto index = new_indices.at(task.task_id);
            for (const auto dependency : entries_[index].dependencies) {
                dependents_[_index_for_locked(dependency)].push_back(index);
            }
            _set_pending_locked(entries_[index], false, clock()->now());
        }
        _condition.notify_all();
    }

    void _validate_dependencies_locked(
        const std::vector<task_id_t>& dependencies,
        const std::unordered_set<task_id_t>& existing_ids,
        const std::unordered_map<task_id_t, std::size_t>* new_ids = nullptr) const {
        for (const auto dependency : dependencies) {
            const bool exists = existing_ids.find(dependency) != existing_ids.end();
            const bool is_new = new_ids != nullptr &&
                                new_ids->find(dependency) != new_ids->end();
            if (!exists && !is_new) {
                throw UnknownTaskError("dependency task does not exist");
            }
        }
    }

    void _set_pending_locked(Entry& entry,
                             bool was_ready,
                             clock_time_point now,
                             std::optional<task_id_t> policy_satisfied_id = std::nullopt,
                             bool mark_failed_succeeded = false) {
        std::size_t pending = 0;
        for (const auto dependency : entry.dependencies) {
            const auto dependency_index = _index_for_locked(dependency);
            const auto& dependency_entry = entries_[dependency_index];
            const bool satisfied = dependency_entry.state == TaskState::Succeeded ||
                                   (mark_failed_succeeded &&
                                    policy_satisfied_id.has_value() &&
                                    dependency_entry.task_id == *policy_satisfied_id);
            if (!satisfied) {
                ++pending;
            }
        }

        const bool will_ready = pending == 0 && entry.ready_at <= now;
        entry.pending_dependencies = pending;
        entry.state = will_ready ? TaskState::Ready : TaskState::Pending;
        if (!was_ready && will_ready) {
            ++ready_count_;
        }
        _remove_from_index_locked(entry);
        if (will_ready) {
            _insert_ready_locked(entry);
        } else {
            _insert_pending_locked(entry);
        }
    }

    void _insert_ready_locked(const Entry& entry) {
        const auto index = _index_for_locked(entry.task_id);
        if (entries_[index].state != TaskState::Ready) {
            auto ready = entry;
            ready.state = TaskState::Ready;
            entries_[index] = std::move(ready);
        }
        ready_heap_.push(HeapEntry{entries_[index].ready_at,
                                   entries_[index].priority,
                                   ++sequence_,
                                   index,
                                   entries_[index].revision});
    }

    void _insert_pending_locked(const Entry& entry) {
        const auto index = _index_for_locked(entry.task_id);
        if (entry.pending_dependencies != 0 ||
            entry.ready_at <= clock()->now()) {
            return;
        }
        due_heap_.push(HeapEntry{entries_[index].ready_at,
                                 entries_[index].priority,
                                 ++sequence_,
                                 index,
                                 entries_[index].revision});
    }

    void _remove_from_index_locked(const Entry& entry) {
        if (entry.state == TaskState::Ready) {
            ready_heap_.erase(HeapEntry{entry.ready_at,
                                        entry.priority,
                                        0,
                                        _index_for_locked(entry.task_id),
                                        entry.revision});
        } else if (entry.state == TaskState::Pending &&
                   entry.pending_dependencies == 0) {
            due_heap_.erase(HeapEntry{entry.ready_at,
                                      entry.priority,
                                      0,
                                      _index_for_locked(entry.task_id),
                                      entry.revision});
        }
    }

    void _promote_due_locked() {
        while (!ready_heap_.empty()) {
            const auto top = ready_heap_.top_entry();
            if (!ready_heap_.contains(top.task_index, top.revision)) {
                ready_heap_.pop();
            } else {
                break;
            }
        }

        const auto now = clock()->now();
        while (!due_heap_.empty() && due_heap_.top_entry().ready_at <= now) {
            const auto heap_entry = due_heap_.pop();
            auto& task = entries_[heap_entry.task_index];
            if (task.revision != heap_entry.revision ||
                task.state != TaskState::Pending ||
                task.pending_dependencies != 0) {
                continue;
            }
            if (task.ready_at > now) {
                _insert_pending_locked(task);
                continue;
            }
            _set_pending_locked(task, false, now);
        }
        _clean_ready_heap_locked();
    }

    void _successors_of_completed(const task_id_t completed_id,
                                  bool mark_failed_succeeded) {
        const auto index = _index_for_locked(completed_id);
        const auto dependents = dependents_.find(index);
        if (dependents == dependents_.end()) {
            return;
        }
        for (const auto dependent_index : dependents->second) {
            auto& task = entries_[dependent_index];
            if (task.state != TaskState::Pending) {
                continue;
            }
            _set_pending_locked(task, false, clock()->now(), completed_id,
                                mark_failed_succeeded);
        }
    }

    [[nodiscard]] std::unordered_map<task_id_t, TaskRecord> _update_tasks_locked(
        const std::unordered_map<task_id_t, TaskChanges>& changes) {
        if (changes.empty()) {
            return {};
        }
        const auto normalised = _normalise_changes(changes);
        for (const auto& [task_id, change] : normalised) {
            const auto index = _require_index_locked(task_id);
            const auto& old = entries_[index];
            if (old.state == TaskState::Running ||
                old.state == TaskState::Succeeded ||
                old.state == TaskState::Failed ||
                old.state == TaskState::Cancelled) {
                throw InvalidTaskStateError("task is not schedulable");
            }
            if (change.expected_revision.has_value() &&
                change.expected_revision.value() != old.revision) {
                throw InvalidTaskStateError("task revision does not match expected revision");
            }
            if (change.dependencies.has_value()) {
                for (const auto dependency : *change.dependencies) {
                    if (dependency == task_id) {
                        throw TaskUpdateError("task cannot depend on itself");
                    }
                    if (_index_for_locked(dependency) == old_size_locked()) {
                        throw UnknownTaskError("dependency task does not exist");
                    }
                }
            }
        }

        const auto graph = _candidate_dependents_locked(normalised);
        if (!allow_cycles_ && _has_cycle_all_locked(graph)) {
            throw DependencyCycleError();
        }

        const auto now = clock()->now();
        for (const auto& [task_id, change] : normalised) {
            const auto index = _require_index_locked(task_id);
            const auto old = entries_[index];
            _remove_from_index_locked(old);
            if (old.state == TaskState::Ready) {
                --ready_count_;
            }

            auto updated = old;
            if (change.priority.has_value()) {
                updated.priority = *change.priority;
            }
            if (change.ready_at.has_value()) {
                updated.ready_at = *change.ready_at;
            }
            updated.dependencies = change.dependencies.has_value()
                                       ? *change.dependencies
                                       : old.dependencies;
            ++updated.revision;
            updated.claim_token = 0;

            for (const auto dependency : old.dependencies) {
                auto& reverse = dependents_[_index_for_locked(dependency)];
                reverse.erase(std::remove(reverse.begin(), reverse.end(), index),
                              reverse.end());
            }
            for (const auto dependency : updated.dependencies) {
                dependents_[_index_for_locked(dependency)].push_back(index);
            }
            entries_[index] = std::move(updated);
            _set_pending_locked(entries_[index],
                                old.state == TaskState::Ready,
                                now);
        }
        _condition.notify_all();

        std::unordered_map<task_id_t, TaskRecord> result;
        result.reserve(normalised.size());
        for (const auto& [task_id, change] : normalised) {
            (void)change;
            result[task_id] =
                _snapshot(entries_[_require_index_locked(task_id)]);
        }
        return result;
    }

    [[nodiscard]] std::unordered_map<task_id_t, TaskChanges> _normalise_changes(
        const std::unordered_map<task_id_t, TaskChanges>& changes) const {
        std::unordered_map<task_id_t, TaskChanges> normalised;
        normalised.reserve(changes.size());
        for (const auto& [task_id, change] : changes) {
            TaskChanges copied = change;
            if (copied.dependencies.has_value()) {
                std::unordered_set<task_id_t> seen;
                std::vector<task_id_t> unique;
                unique.reserve(copied.dependencies->size());
                for (const auto dependency : *copied.dependencies) {
                    if (seen.insert(dependency).second) {
                        unique.push_back(dependency);
                    }
                }
                copied.dependencies = std::move(unique);
            }
            normalised[task_id] = std::move(copied);
        }
        return normalised;
    }

    [[nodiscard]] bool _has_cycle_all_locked(
        const std::vector<std::vector<std::size_t>>& dependents) const {
        std::vector<std::size_t> remaining(entries_.size(), 0);
        std::queue<std::size_t> queue;
        for (std::size_t index = 0; index < entries_.size(); ++index) {
            remaining[index] = entries_[index].dependencies.size();
            if (remaining[index] == 0) {
                queue.push(index);
            }
        }
        std::size_t visited = 0;
        while (!queue.empty()) {
            const auto task_index = queue.front();
            queue.pop();
            ++visited;
            const auto successors = dependents.find(task_index);
            if (successors == dependents.end()) {
                continue;
            }
            for (const auto dependent_index : successors->second) {
                if (dependent_index >= remaining.size()) {
                    throw std::logic_error("invalid dependency index");
                }
                if (--remaining[dependent_index] == 0) {
                    queue.push(dependent_index);
                }
            }
        }
        return visited != entries_.size();
    }

    [[nodiscard]] std::optional<std::vector<task_id_t>> _find_cycle_from_locked(
        const std::vector<std::vector<std::size_t>>& dependents) const {
        std::vector<int> colour(entries_.size(), 0);
        std::vector<std::size_t> parent(entries_.size(), kNoIndex);
        std::vector<std::size_t> cursor(entries_.size(), 0);
        std::vector<std::size_t> stack;
        stack.reserve(entries_.size());
        for (std::size_t start = 0; start < entries_.size(); ++start) {
            if (colour[start] != 0) {
                continue;
            }
            colour[start] = 1;
            stack.push_back(start);
            while (!stack.empty()) {
                const auto task_index = stack.back();
                if (cursor[task_index] < entries_[task_index].dependencies.size()) {
                    const auto dependency_index =
                        _index_for_locked(entries_[task_index].dependencies[cursor[task_index]++]);
                    if (colour[dependency_index] == 0) {
                        colour[dependency_index] = 1;
                        parent[dependency_index] = task_index;
                        cursor[dependency_index] = 0;
                        stack.push_back(dependency_index);
                    } else if (colour[dependency_index] == 1) {
                        std::vector<task_id_t> cycle;
                        cycle.push_back(entries_[dependency_index].task_id);
                        std::size_t cursor_index = task_index;
                        while (cursor_index != dependency_index) {
                            cycle.push_back(entries_[cursor_index].task_id);
                            cursor_index = parent[cursor_index];
                        }
                        cycle.push_back(entries_[dependency_index].task_id);
                        return cycle;
                    }
                    continue;
                }
                colour[task_index] = 2;
                parent[task_index] = kNoIndex;
                stack.pop_back();
            }
        }
        return std::nullopt;
    }

    void _clean_ready_heap_locked() {
        while (!ready_heap_.empty()) {
            const auto top = ready_heap_.top_entry();
            if (!ready_heap_.contains(top.task_index, top.revision)) {
                ready_heap_.pop();
            } else {
                break;
            }
        }
    }

    [[nodiscard]] std::size_t old_size_locked() const noexcept {
        return entries_.size();
    }

    static constexpr std::size_t kNoIndex =
        static_cast<std::size_t>(-1);

    void _validate_lease(const Entry& task,
                         const task_id_t task_id,
                         std::uint64_t lease_token) const {
        if (task.task_id != task_id || task.state != TaskState::Running ||
            task.claim_token != lease_token || lease_token == 0) {
            throw ClaimMismatchError("invalid or expired claim token");
        }
    }

    [[nodiscard]] TaskRecord _snapshot(const Entry& entry) const {
        TaskRecord record;
        record.task_id = entry.task_id;
        record.priority = entry.priority;
        record.ready_at = entry.ready_at;
        record.dependencies = entry.dependencies;
        record.state = entry.state;
        record.revision = entry.revision;
        record.pending_dependencies = entry.pending_dependencies;
        record.claim_token = entry.claim_token;
        return record;
    }

    std::size_t max_tasks_ = default_capacity;
    const Clock* clock_ = nullptr;
    bool allow_cycles_ = false;
    std::vector<Entry> entries_;
    std::unordered_map<task_id_t, std::size_t> id_to_index_;
    std::vector<std::vector<std::size_t>> dependents_;
    IndexHeap<ReadyLess> ready_heap_;
    IndexHeap<DueLess> due_heap_;
    std::size_t ready_count_ = 0;
    std::uint64_t sequence_ = 0;
    std::uint64_t lease_counter_ = 0;
    mutable std::mutex mutex_;
    std::condition_variable condition_;
};

using DefaultTaskScheduler = TaskScheduler;

}  // namespace nex

#endif  // NEX_TASK_SCHEDULER_HPP
