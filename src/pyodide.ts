import type { TraceSnapshot, ExecutionResult } from './interpreter';

let pyodideInstance: any = null;

export async function initPyodide() {
  if (!pyodideInstance) {
    if (!(window as any).loadPyodide) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.js';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Failed to load Pyodide CDN script'));
        document.head.appendChild(script);
      });
    }
    pyodideInstance = await (window as any).loadPyodide({
      indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.25.0/full/'
    });
  }
  return pyodideInstance;
}

export async function executePython(code: string): Promise<ExecutionResult> {
  const py = await initPyodide();
  
  // Preprocess code: if user pasted standalone def func(self, ...) without class, remove self
  let preprocessedCode = code;
  if (!/class\s+\w+/.test(code)) {
    preprocessedCode = code.replace(/^(\s*def\s+\w+\s*\(\s*)self\s*(?:,\s*)?/gm, '$1');
  }
  
  py.FS.writeFile('/main.py', preprocessedCode);
  
  const setupCode = `
import sys
import json
import linecache
import typing
import collections

trace_data = []
output_data = []
error_info = None
step_count = 0
MAX_STEPS = 2000

class CaptureStdout:
    def __init__(self):
        self.buffer = ""
    def write(self, text):
        self.buffer += text
        if '\\n' in self.buffer:
            lines = self.buffer.split('\\n')
            for line in lines[:-1]:
                output_data.append(line)
            self.buffer = lines[-1]
    def flush(self):
        if self.buffer:
            output_data.append(self.buffer)
            self.buffer = ""

sys.stdout = CaptureStdout()

def trace_calls(frame, event, arg):
    global step_count
    if frame.f_code.co_filename != '/main.py':
        return None
        
    if event in ('call', 'line', 'return'):
        step_count += 1
        if step_count > MAX_STEPS:
            raise RuntimeError("Execution stopped: maximum trace steps exceeded (potential infinite loop).")
            
        call_stack = []
        f = frame
        while f and f.f_code.co_filename == '/main.py':
            vars_dict = {}
            for k, v in f.f_locals.items():
                if k.startswith('__') or callable(v) or str(type(v)) == "<class 'module'>":
                    continue
                if f.f_code.co_name == '<module>':
                    if getattr(typing, k, None) is v or getattr(collections, k, None) is v:
                        continue
                    if str(type(v)).startswith("<class 'typing."):
                        continue
                vars_dict[k] = repr(v)
            
            call_stack.insert(0, {
                'name': f.f_code.co_name if f.f_code.co_name != '<module>' else '<module>',
                'variables': vars_dict
            })
            f = f.f_back
            
        eval_result = ""
        if event == 'line':
            line_text = linecache.getline('/main.py', frame.f_lineno).strip()
            try:
                if line_text.startswith("if "):
                    expr = line_text[3:].strip().rstrip(":")
                    res = eval(expr, frame.f_globals, frame.f_locals)
                    eval_result = f"Condition evaluates to: {res}"
                elif line_text.startswith("elif "):
                    expr = line_text[5:].strip().rstrip(":")
                    res = eval(expr, frame.f_globals, frame.f_locals)
                    eval_result = f"Condition evaluates to: {res}"
                elif line_text.startswith("while "):
                    expr = line_text[6:].strip().rstrip(":")
                    res = eval(expr, frame.f_globals, frame.f_locals)
                    eval_result = f"Condition evaluates to: {res}"
            except Exception:
                pass
        
        trace_data.append({
            'line': frame.f_lineno,
            'callStack': call_stack,
            'output': list(output_data),
            'evalContext': eval_result
        })
    return trace_calls

sys.settrace(trace_calls)

try:
    with open('/main.py', 'r') as f:
        code_obj = compile(f.read(), '/main.py', 'exec')
        exec_globals = {"__name__": "__main__", "__builtins__": __builtins__}
        import typing, collections
        for k in dir(typing):
            if not k.startswith('_'): exec_globals[k] = getattr(typing, k)
        for k in dir(collections):
            if not k.startswith('_'): exec_globals[k] = getattr(collections, k)
            
        # Inject standard LeetCode data structures
        class ListNode:
            def __init__(self, val=0, next=None):
                self.val = val
                self.next = next
            def __repr__(self):
                return f"ListNode({self.val})"
                
        class TreeNode:
            def __init__(self, val=0, left=None, right=None):
                self.val = val
                self.left = left
                self.right = right
            def __repr__(self):
                return f"TreeNode({self.val})"
                
        exec_globals['ListNode'] = ListNode
        exec_globals['TreeNode'] = TreeNode
        
        exec(code_obj, exec_globals)
    sys.stdout.flush()
except BaseException as e:
    import sys, traceback
    if isinstance(e, SyntaxError):
        error_info = {"msg": f"{type(e).__name__}: {e.msg}", "line": getattr(e, 'lineno', -1)}
    else:
        tb = sys.exc_info()[2]
        err_line = -1
        while tb:
            if tb.tb_frame.f_code.co_filename == '/main.py':
                err_line = tb.tb_lineno
            tb = tb.tb_next
        error_info = {"msg": f"{type(e).__name__}: {str(e)}", "line": err_line}
finally:
    sys.settrace(None)
    sys.stdout = sys.__stdout__
`;
  
  py.runPython(setupCode);
  
  const rawTrace = py.globals.get('trace_data').toJs();
  const rawErrorInfo = py.globals.get('error_info');
  let errorMsg = undefined;
  let errorLine = undefined;
  if (rawErrorInfo) {
      const errorMap = rawErrorInfo.toJs();
      errorMsg = errorMap.get('msg');
      errorLine = errorMap.get('line');
      if (errorLine === -1) errorLine = undefined;
  }
  
  // Transform output slightly to match JS snapshot structure exactly
  const trace: TraceSnapshot[] = [];
  for (const t of rawTrace) {
      const step: TraceSnapshot = {
          line: t.get('line'),
          callStack: [],
          output: [],
          evalContext: t.get('evalContext') || undefined
      };
      
      const stack = t.get('callStack');
      for (const frame of stack) {
          const varsMap = frame.get('variables');
          const vars: Record<string, string> = {};
          if (varsMap) {
             for (const [k, v] of varsMap.entries()) {
                 vars[k] = v;
             }
          }
          step.callStack.push({
              name: frame.get('name'),
              variables: vars
          });
      }
      
      const outList = t.get('output');
      for (const o of outList) {
          step.output.push(o);
      }
      trace.push(step);
  }
  
  return { trace, error: errorMsg, line: errorLine };
}
