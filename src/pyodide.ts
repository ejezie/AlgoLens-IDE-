import type { TraceSnapshot } from './interpreter';

let pyodideInstance: any = null;

export async function initPyodide() {
  if (!pyodideInstance) {
    // Requires the pyodide script to be loaded in index.html
    pyodideInstance = await (window as any).loadPyodide({
      indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.25.0/full/'
    });
  }
  return pyodideInstance;
}

export async function executePython(code: string): Promise<TraceSnapshot[]> {
  const py = await initPyodide();
  
  py.FS.writeFile('/main.py', code);
  
  const setupCode = `
import sys
import json
import linecache

trace_data = []
output_data = []
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
            vars_dict = {k: repr(v) for k, v in f.f_locals.items() if not k.startswith('__') and not callable(v) and str(type(v)) != "<class 'module'>"}
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
        exec(code_obj, exec_globals)
    sys.stdout.flush()
except Exception as e:
    import traceback
    output_data.append(traceback.format_exc().splitlines()[-1])
finally:
    sys.settrace(None)
    sys.stdout = sys.__stdout__
`;
  
  py.runPython(setupCode);
  
  const rawTrace = py.globals.get('trace_data').toJs();
  
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
  
  return trace;
}
