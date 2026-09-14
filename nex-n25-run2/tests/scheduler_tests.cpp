#include "nex_scheduler.hpp"

#include <cassert>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <optional>
#include <random>
#include <thread>
#include <vector>

namespace {

using nx::clock_t;
using nx::task_id_t;
using nx::Task;
using nx::TaskHandle;
using nx::TaskRecord;
using nx::TaskScheduler;

struct FakeClock {
    clock_t now = clock_t::from_duration(clock_t::duration::zero());

    clock_t time() const noexcept { return now; }

    void advance(std::chrono::milliseconds amount) {
        now += amount;
    }
};

using TestScheduler = TaskScheduler<task_id_t, FakeClock>;

TestScheduler scheduler_with(FakeClock& clock, std::size_t capacity = 1024) {
    return TestScheduler(capacity, clock);
}

Task make_task(task_id_t id,
               int priority = 0,
               clock_t ready_at = clock_t::from_duration(clock_t::duration::zero()),
               std::vector<task_id_t> dependencies = {}) {
    return Task{id, priority, ready_at, std::move(dependencies)};
}

void require_equal(task_id_t actual, task_id_t expected) {
    assert(actual == expected);
}

}  // namespace

int main() {
    {
        FakeClock clock;
        auto scheduler = scheduler_with(clock);
        scheduler.add(make_task(2, 1, clock_t::from_milliseconds(10)));
        scheduler.add(make_task(1, 1, clock_t::from_milliseconds(0)));
        scheduler.add(make_task(0, 10, clock_t::from_milliseconds(0)));

        assert(scheduler.peek_next().value().task_id == 0);
        assert(scheduler.next_task().value().task_id == 0);
        assert(scheduler.peek_next().value().task_id == 1);
        assert(scheduler.next_task().value().task_id == 1);
        assert(scheduler.peek_next().value().task_id == 2);
        assert(scheduler.next_task().value().task_id == 2);
        assert(scheduler.next_task().has_value() == false);
    }

    {
        FakeClock clock;
        auto scheduler = scheduler_with(clock);
        scheduler.add(make_task(10, 0, clock_t::from_milliseconds(5)));

        assert(scheduler.peek_next().has_value() == false);
        clock.advance(std::chrono::milliseconds(4));
        assert(scheduler.peek_next().has_value() == false);
        clock.advance(std::chrono::milliseconds(1));
        assert(scheduler.peek_next().value().task_id == 10);
    }

    {
        FakeClock clock;
        auto scheduler = scheduler_with(clock);
        scheduler.register_tasks({
            make_task(1, 0, clock_t::duration::zero(), {2}),
            make_task(2, 0, clock_t::duration::zero(), {}),
        });

        assert(scheduler.peek_next().value().task_id == 2);
        auto lease = scheduler.next_task();
        assert(lease.value().task_id == 2);
        scheduler.complete(lease.value());
        assert(scheduler.peek_next().value().task_id == 1);
        auto child = scheduler.next_task();
        assert(child.value().task_id == 1);
    }

    {
        FakeClock clock;
        auto scheduler = scheduler_with(clock);
        scheduler.register_tasks({
            make_task(1, 0, clock_t::duration::zero(), {2}),
            make_task(2, 0, clock_t::duration::zero(), {}),
        });
        auto parent = scheduler.next_task();
        assert(parent.value().task_id == 2);
        scheduler.fail(parent.value());
        assert(scheduler.peek_next().has_value() == false);

        auto retried = scheduler.retry(parent.value(), clock_t::from_milliseconds(0));
        assert(retried.state() == nx::TaskState::Submitted);
        assert(scheduler.next_task().value().task_id == 2);
        scheduler.complete(scheduler.next_task().value());
        assert(scheduler.peek_next().value().task_id == 1);
    }

    {
        FakeClock clock;
        auto scheduler = scheduler_with(clock);
        scheduler.register_tasks({
            make_task(1, 1, clock_t::duration::zero(), {2}),
            make_task(2, 0, clock_t::duration::zero(), {}),
        });
        auto parent = scheduler.next_task();
        assert(parent.value().task_id == 2);
        scheduler.complete(parent.value());

        scheduler.update_ready_at(1, clock_t::from_milliseconds(10));
        scheduler.update_priority(1, 100);
        assert(scheduler.peek_next().has_value() == false);
        assert(scheduler.get_task_record(1).execution_timestamp == clock_t::from_milliseconds(10));
        assert(scheduler.get_task_record(1).priority == 100);

        scheduler.replace_dependencies(1, {3});
        scheduler.register_task(make_task(3, 0, clock_t::duration::zero(), {}));
        assert(scheduler.peek_next().has_value() == false);

        scheduler.replace_dependencies(1, {});
        assert(scheduler.peek_next().value().task_id == 1);
    }

    {
        FakeClock clock;
        auto scheduler = scheduler_with(clock);
        assert(scheduler.add(make_task(1, 0, {}, {})));
        assert(!scheduler.add(make_task(1, 0, {}, {})));
        assert(scheduler.task_count() == 1);

        assert(scheduler.register_task(make_task(2, 0, {}, {3})));
        assert(!scheduler.register_task(make_task(3, 0, {}, {2})));
        assert(scheduler.has_cycle() == false);

        auto before = scheduler.get_task_record(2);
        assert(scheduler.replace_dependencies(2, {2}) == false);
        assert(scheduler.get_task_record(2) == before);
    }

    {
        FakeClock clock;
        auto scheduler = scheduler_with(clock);
        scheduler.register_tasks({
            make_task(1, 0, clock_t::duration::zero(), {}),
            make_task(2, 0, clock_t::duration::zero(), {}),
            make_task(3, 0, clock_t::duration::zero(), {}),
            make_task(4, 0, clock_t::duration::zero(), {}),
        });

        std::atomic<int> attempts = 0;
        std::vector<std::thread> workers;
        std::vector<TaskHandle> claims;
        for (int worker = 0; worker < 8; ++worker) {
            workers.emplace_back([&] {
                for (;;) {
                    auto lease = scheduler.next_task();
                    if (!lease) break;
                    claims.push_back(lease.value());
                }
            });
        }
        for (auto& worker : workers) worker.join();

        std::set<task_id_t> ids;
        for (auto& lease : claims) ids.insert(lease.task_id);
        assert(ids.size() == 4);
        assert(scheduler.peek_next().has_value() == false);
    }

    {
        FakeClock clock;
        auto scheduler = scheduler_with(clock);
        assert(scheduler.capacity() == 2);
        assert(scheduler.add(make_task(1)) == false);
        assert(scheduler.add(make_task(2)) == true);
        assert(scheduler.add(make_task(3)) == false);
    }

    std::cout << "scheduler unit tests passed\n";
    return 0;
}
