"""
Tests for TaskScheduler
"""
import time
from scheduler import TaskScheduler, CycleError, SchedulerError

def test_basic_order():
    s = TaskScheduler()
    s.add_task("a", scheduled_time=10, priority=1)
    s.add_task("b", scheduled_time=5, priority=2)
    s.add_task("c", scheduled_time=5, priority=1)
    # ready heap drained at now=10
    t1 = s.get_next_task(now=10)
    assert t1.id == "c", f"expected c got {t1.id}"
    t2 = s.get_next_task(now=10)
    assert t2.id == "b"
    t3 = s.get_next_task(now=10)
    assert t3.id == "a"

def test_dependencies():
    s = TaskScheduler()
    s.add_task("a", scheduled_time=0)
    s.add_task("b", scheduled_time=0)
    s.add_task("c", scheduled_time=0, depends_on=["a","b"])
    # c should be pending
    assert s.pending_count() == 1
    s.complete_task("a")
    assert s.pending_count() == 1
    s.complete_task("b")
    # now c ready
    t = s.get_next_task(now=0)
    assert t.id == "c"

def test_cycle_detection():
    s = TaskScheduler()
    s.add_task("a", 0)
    s.add_task("b", 0)
    s.add_task("c", 0)
    s.add_dependency("b", "a")
    s.add_dependency("c", "b")
    try:
        s.add_dependency("a", "c")
        assert False, "cycle not detected"
    except CycleError:
        pass

def test_dynamic_update():
    s = TaskScheduler()
    s.add_task("a", scheduled_time=100, priority=5)
    s.add_task("b", scheduled_time=10, priority=1)
    s.update_task("a", scheduled_time=5, priority=0)
    t = s.get_next_task(now=10)
    assert t.id == "a", f"expected a got {t.id}"

def test_future_drain():
    s = TaskScheduler()
    s.add_task("future", scheduled_time=1000)
    assert s.get_next_task(now=0) is None
    t = s.get_next_task(now=1000)
    assert t.id == "future"

def test_cancel():
    s = TaskScheduler()
    s.add_task("x", 0)
    s.cancel_task("x")
    assert s.get_next_task(now=0) is None

def test_duplicate():
    s = TaskScheduler()
    s.add_task("a", 0)
    try:
        s.add_task("a", 0)
        assert False
    except SchedulerError:
        pass

def test_version_invalidation():
    s = TaskScheduler()
    s.add_task("a", 0, priority=10)
    s.update_task("a", priority=0)
    t = s.get_next_task(now=0)
    assert t.id == "a" and t.priority == 0

if __name__ == "__main__":
    test_basic_order()
    test_dependencies()
    test_cycle_detection()
    test_dynamic_update()
    test_future_drain()
    test_cancel()
    test_duplicate()
    test_version_invalidation()
    print("All tests passed")
