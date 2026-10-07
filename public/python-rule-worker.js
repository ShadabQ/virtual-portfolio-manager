let pyodide;

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const pyodideModule = await import('https://cdn.jsdelivr.net/pyodide/v0.28.2/full/pyodide.mjs');
            pyodide = await pyodideModule.loadPyodide({
                indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.28.2/full/',
            });
      self.postMessage({ type: 'ready' });
      return;
    }

    if (data.type !== 'run' || !pyodide) throw new Error('Python runtime is not ready.');
    if (typeof data.code !== 'string' || data.code.length > 25000) throw new Error('Rule code is empty or too large.');
    if (!Array.isArray(data.stocks) || data.stocks.length > 500) throw new Error('Invalid watchlist input.');

    pyodide.globals.set('__rule_source', data.code);
    pyodide.globals.set('__rule_stocks', pyodide.toPy(data.stocks));
    const output = await pyodide.runPythonAsync(`
import ast
import json
import math
_rule_tree = ast.parse(__rule_source)
_rule_blocked_calls = {
    '__import__', 'eval', 'exec', 'compile', 'open', 'input', 'getattr',
    'setattr', 'delattr', 'vars', 'dir', 'globals', 'locals', 'help', 'breakpoint'
}
for _rule_node in ast.walk(_rule_tree):
    if isinstance(_rule_node, (ast.Import, ast.ImportFrom)):
        raise ValueError('Imports are disabled in the browser rule sandbox.')
    if isinstance(_rule_node, ast.Name) and _rule_node.id.startswith('_'):
        raise ValueError('Names beginning with an underscore are not allowed.')
    if isinstance(_rule_node, ast.Attribute) and _rule_node.attr.startswith('_'):
        raise ValueError('Private attributes are not allowed.')
    if isinstance(_rule_node, ast.Call) and isinstance(_rule_node.func, ast.Name) and _rule_node.func.id in _rule_blocked_calls:
        raise ValueError('That Python operation is disabled in the rule sandbox.')
    if isinstance(_rule_node, ast.Constant) and isinstance(_rule_node.value, str) and '__' in _rule_node.value:
        raise ValueError('Dunder strings are not allowed.')
if not any(isinstance(_rule_node, (ast.FunctionDef, ast.AsyncFunctionDef)) and _rule_node.name == 'screen' for _rule_node in _rule_tree.body):
    raise ValueError('Define screen(stocks) in your rule.')
_rule_safe_builtins = {
    'abs': abs, 'all': all, 'any': any, 'bool': bool, 'dict': dict,
    'enumerate': enumerate, 'filter': filter, 'float': float, 'int': int,
    'len': len, 'list': list, 'map': map, 'max': max, 'min': min,
    'range': range, 'round': round, 'set': set, 'sorted': sorted,
    'str': str, 'sum': sum, 'tuple': tuple, 'zip': zip,
}
_rule_namespace = {
    '__builtins__': _rule_safe_builtins,
    'math': math,
    'stocks': __rule_stocks,
}
exec(compile(_rule_tree, '<portfolio-rule>', 'exec'), _rule_namespace, _rule_namespace)
_rule_result = _rule_namespace['screen'](__rule_stocks)
if not isinstance(_rule_result, list):
    raise ValueError('screen(stocks) must return a list.')
_rule_symbols = []
for _rule_item in _rule_result:
    if isinstance(_rule_item, str):
        _rule_symbols.append(_rule_item)
    elif isinstance(_rule_item, dict) and isinstance(_rule_item.get('symbol'), str):
        _rule_symbols.append(_rule_item['symbol'])
    else:
        raise ValueError('Return stock symbols or stock rows.')
json.dumps(_rule_symbols)
`);
    self.postMessage({ type: 'result', symbols: JSON.parse(output) });
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || 'Python rule failed.' });
  }
};
