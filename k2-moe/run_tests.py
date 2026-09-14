#!/usr/bin/env python3
"""Zero-dependency test runner shim (no pytest installed in this env).

Provides the subset of pytest we use: `raises`, class-based grouping,
and simple assertion passthrough. Run:  python3 run_tests.py
"""
import inspect
import sys
import traceback
from contextlib import contextmanager


@contextmanager
def raises(exc):
    try:
        yield
    except exc:
        return
    except Exception as e:
        raise AssertionError(f"expected {exc.__name__}, got {type(e).__name__}: {e}")
    raise AssertionError(f"expected {exc.__name__}, but no exception was raised")


# Provide a minimal `pytest` stub so test modules using `pytest.raises`
# resolve without the real package being installed.
import types
pytest_stub = types.ModuleType("pytest")
pytest_stub.raises = raises
sys.modules["pytest"] = pytest_stub


def iter_tests(mod):
    """Yield (name, callable) for module-level test functions AND
    Test* class methods (pytest-style discovery)."""
    for name, obj in inspect.getmembers(mod):
        if inspect.isclass(obj):
            if name.startswith("Test"):
                for mname, mfn in inspect.getmembers(obj, inspect.isfunction):
                    if mname.startswith("test_"):
                        yield f"{name}.{mname}", mfn
        elif callable(obj) and getattr(obj, "__name__", "").startswith("test_"):
            yield name, obj


def main():
    import test_scheduler as mod

    passed = failed = errors = 0
    failures = []

    for name, fn in iter_tests(mod):
        try:
            fn()
            passed += 1
        except Exception as e:
            failed += 1
            failures.append((name, e, traceback.format_exc()))

    print(f"\n{'='*60}")
    print(f"passed={passed}  failed={failed}")
    for name, e, tb in failures:
        print(f"\n--- {name} ---")
        print(tb[-1500:])
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()