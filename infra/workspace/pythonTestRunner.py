# coverage-exempt: Review-runner bootstrap; its purpose is to trace the selected source consumers, without a Python coverage dependency.
import dis
import importlib.util
import pathlib
import sys
import trace
import types
import unittest


# coverage-exempt: Review-runner bootstrap; the tracer does not trace the runner that installs it.
def run_tests():
    suite = unittest.TestSuite()
    for index, file in enumerate(sys.argv[1:]):
        spec = importlib.util.spec_from_file_location(f'python_test_{index}', file)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        suite.addTests(unittest.defaultTestLoader.loadTestsFromModule(module))
    return unittest.TextTestRunner(verbosity=2).run(suite)


# coverage-exempt: Review-runner bootstrap; the tracer does not trace the runner that installs it.
def lines(code):
    result = {number for _offset, number in dis.findlinestarts(code) if number}
    for constant in code.co_consts:
        if isinstance(constant, types.CodeType):
            result.update(lines(constant))
    return result


# coverage-exempt: Review-runner bootstrap and report serialization are outside the source being reviewed.
tracer = trace.Trace(count=True, trace=False)
# runctx also traces worker threads, such as a socket server's handlers.
scope = {'run_tests': run_tests}
tracer.runctx('result = run_tests()', scope, scope)
result = scope['result']
counts = tracer.results().counts
root = pathlib.Path.cwd()
records = []
for file in sorted({file for file, _line in counts}):
    path = pathlib.Path(file)
    if not path.is_relative_to(root) or path == pathlib.Path(__file__).resolve():
        continue
    code = compile(path.read_text(), str(path), 'exec')
    records.extend(['TN:', 'SF:' + str(path)])
    records.extend(f'DA:{line},{counts.get((file, line), 0)}' for line in sorted(lines(code)))
    records.append('end_of_record')
output = root / 'tmp/python-tests/lcov.info'
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text('\n'.join(records) + '\n')
sys.exit(0 if result.wasSuccessful() else 1)
