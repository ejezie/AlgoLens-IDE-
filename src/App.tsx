/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import Editor, { useMonaco } from '@monaco-editor/react';
import { Play, Pause, SkipForward, SkipBack, PlayCircle, Settings, X, Terminal, Code2, Loader2, RotateCcw } from 'lucide-react';
import { executeJS, TraceSnapshot } from './interpreter';
import { executePython, initPyodide } from './pyodide';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const DEFAULT_JS = `function binarySearch(arr, target) {
  let left = 0;
  let right = arr.length - 1;
  
  while (left <= right) {
    let mid = Math.floor((left + right) / 2);
    
    if (arr[mid] === target) return mid;
    
    if (arr[mid] < target) {
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  return -1;
}

const arr = [1, 3, 5, 7, 9, 11];
console.log("Found at index:", binarySearch(arr, 7));
`;

const DEFAULT_PY = `def isAnagram(s: str, t: str) -> bool:
    if len(s) != len(t):
        return False
    countS, countT = {}, {}
    for i in range(len(s)):
        countS[s[i]] = 1 + countS.get(s[i], 0)
        countT[t[i]] = 1 + countT.get(t[i], 0)       
    for c in countS:
        if countS[c] != countT.get(c, 0):
            return False
    return True

print("Is 'anagram' an anagram of 'nagaram'?", isAnagram('anagram', 'nagaram'))
`;

export default function App() {
  const [language, setLanguage] = useState<'javascript' | 'python'>('python');
  const [codeJS, setCodeJS] = useState(DEFAULT_JS);
  const [codePy, setCodePy] = useState(DEFAULT_PY);
  const [mode, setMode] = useState<'edit' | 'playback'>('edit');
  const [trace, setTrace] = useState<TraceSnapshot[]>([]);
  const [currentStep, setCurrentStep] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(500);
  const [isRunning, setIsRunning] = useState(false);
  const [pyodideReady, setPyodideReady] = useState(false);
  const [pendingTest, setPendingTest] = useState<{
    funcName: string;
    isClass: boolean;
    args: {name: string, type: string}[];
  } | null>(null);
  const [testInputs, setTestInputs] = useState<Record<string, string>>({});

  const monaco = useMonaco();
  const editorRef = useRef<any>(null);
  const [decorations, setDecorations] = useState<string[]>([]);
  const playIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Initialize Pyodide early if possible
  useEffect(() => {
    initPyodide().then(() => setPyodideReady(true)).catch(console.error);
  }, []);

  const handleEditorDidMount = (editor: any) => {
    editorRef.current = editor;
  };

  const currentCode = language === 'javascript' ? codeJS : codePy;
  const setCode = (val: string) => language === 'javascript' ? setCodeJS(val) : setCodePy(val);

  // Handle Monaco Decorations for highlighting the current line
  useEffect(() => {
    if (editorRef.current && monaco) {
      if (mode === 'playback' && trace.length > 0 && currentStep < trace.length) {
        const line = trace[currentStep].line;
        if (line && line > 0) {
          const newDecorations = [
            {
              range: new monaco.Range(line, 1, line, 1),
              options: {
                isWholeLine: true,
                className: 'monaco-highlight-line',
              },
            },
          ];
          setDecorations(editorRef.current.deltaDecorations(decorations, newDecorations));
          
          // Optionally reveal the line in the center of the editor
          editorRef.current.revealLineInCenterIfOutsideViewport(line);
        }
      } else if (mode === 'edit') {
        setDecorations(editorRef.current.deltaDecorations(decorations, []));
      }
    }
  }, [currentStep, mode, trace, monaco]);

  const handleRun = async (overrideCode?: string) => {
    const codeToRun = typeof overrideCode === 'string' ? overrideCode : currentCode;
    if (!codeToRun.trim()) return;
    
    setIsRunning(true);
    setIsPlaying(false);
    
    if (editorRef.current && monaco) {
      monaco.editor.setModelMarkers(editorRef.current.getModel(), 'owner', []);
    }
    
    // Check if code is just function/class definitions without any top-level call or test driver
    if (language === 'python') {
      try {
        const py = await initPyodide();
        const sigJson = py.runPython(`
import ast, json
code_str = ${JSON.stringify(codeToRun)}
def analyze(code_str):
    try:
        tree = ast.parse(code_str)
        
        has_top_call = False
        for node in tree.body:
            if isinstance(node, (ast.Expr, ast.Assign, ast.AnnAssign, ast.Assert)):
                for child in ast.walk(node):
                    if isinstance(child, ast.Call):
                        has_top_call = True
                        break
            if has_top_call:
                break
                
        if has_top_call:
            return json.dumps({"hasCall": True})
            
        def get_type_str(node):
            if not node: return ""
            if isinstance(node, ast.Name): return node.id
            if isinstance(node, ast.Attribute): return node.attr
            if isinstance(node, ast.Constant): return str(node.value) if node.value is not None else ""
            if isinstance(node, ast.Subscript):
                val = get_type_str(node.value)
                sl = get_type_str(node.slice)
                return f"{val}[{sl}]" if sl else val
            if isinstance(node, ast.Tuple):
                return ", ".join(get_type_str(e) for e in node.elts)
            if isinstance(node, ast.List):
                return "[" + ", ".join(get_type_str(e) for e in node.elts) + "]"
            if hasattr(node, 'value'):
                return get_type_str(node.value)
            return ""

        for node in tree.body:
            if isinstance(node, ast.ClassDef):
                for item in node.body:
                    if isinstance(item, ast.FunctionDef) and item.name != '__init__':
                        args = []
                        for a in item.args.args:
                            if a.arg != 'self':
                                ann = get_type_str(a.annotation) if getattr(a, 'annotation', None) else ""
                                args.append({"name": a.arg, "type": ann})
                        return json.dumps({
                            "hasCall": False,
                            "funcName": item.name,
                            "isClass": True,
                            "className": node.name,
                            "args": args
                        })

        for node in tree.body:
            if isinstance(node, ast.FunctionDef):
                args = []
                for a in node.args.args:
                    if a.arg != 'self':
                        ann = get_type_str(a.annotation) if getattr(a, 'annotation', None) else ""
                        args.append({"name": a.arg, "type": ann})
                return json.dumps({
                    "hasCall": False,
                    "funcName": node.name,
                    "isClass": False,
                    "args": args
                })

    except Exception as e:
        pass
    return None

analyze(code_str)
        `);

        if (sigJson) {
          const sig = JSON.parse(sigJson);
          if (!sig.hasCall && sig.funcName) {
            setPendingTest(sig);
            setIsRunning(false);
            return;
          }
        }
      } catch (e) {
        console.error("AST analysis failed:", e);
      }
    } else if (language === 'javascript') {
      const lines = codeToRun.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      const hasTopCall = /console\.log|\w+\s*\([^)]*\)/.test(codeToRun) && !/^(function|class|\}|\/\/)/.test(lastLine.trim());

      if (!hasTopCall) {
        const jsClassMatch = codeToRun.match(/class\s+([a-zA-Z_]\w*)[\s\S]*?([a-zA-Z_]\w*)\s*\(([^)]*)\)/);
        const jsFuncMatch = codeToRun.match(/function\s+([a-zA-Z_]\w*)\s*\(([^)]*)\)/);
        if (jsClassMatch && jsClassMatch[1] && jsClassMatch[2] !== 'constructor') {
          const className = jsClassMatch[1];
          const funcName = jsClassMatch[2];
          const args = jsClassMatch[3].split(',').map(a => a.trim()).filter(a => a && a !== 'this').map(a => ({ name: a, type: '' }));
          setPendingTest({ funcName, isClass: true, className, args } as any);
          setIsRunning(false);
          return;
        } else if (jsFuncMatch) {
          const funcName = jsFuncMatch[1];
          const args = jsFuncMatch[2].split(',').map(a => a.trim()).filter(a => a).map(a => ({ name: a, type: '' }));
          setPendingTest({ funcName, isClass: false, args });
          setIsRunning(false);
          return;
        }
      }
    }

    try {
      let result;
      if (language === 'javascript') {
        result = executeJS(codeToRun);
      } else {
        result = await executePython(codeToRun);
      }
      
      let resultTrace = result.trace;
      
      if (resultTrace.length > 0) {
        if (result.error) {
          if (result.line && result.line > 0 && editorRef.current && monaco) {
            monaco.editor.setModelMarkers(editorRef.current.getModel(), 'owner', [{
              startLineNumber: result.line,
              startColumn: 1,
              endLineNumber: result.line,
              endColumn: 1000,
              message: result.error,
              severity: monaco.MarkerSeverity.Error
            }]);
          }
          resultTrace[resultTrace.length - 1].output.push(`[Execution Error] ${result.error}${result.line && result.line > 0 ? ` (At line ${result.line})` : ''}`);
        }
        setTrace(resultTrace);
        setCurrentStep(prev => Math.min(prev, resultTrace.length - 1));
        setMode('playback');
      } else {
        if (result.error) {
          if (result.line && result.line > 0 && editorRef.current && monaco) {
            monaco.editor.setModelMarkers(editorRef.current.getModel(), 'owner', [{
              startLineNumber: result.line,
              startColumn: 1,
              endLineNumber: result.line,
              endColumn: 1000,
              message: result.error,
              severity: monaco.MarkerSeverity.Error
            }]);
          }
          alert(`Execution Error:\n${result.error}${result.line && result.line > 0 ? `\nAt line ${result.line}` : ''}`);
        } else {
          alert("No executable steps found or program finished instantly without trace.");
        }
      }
    } catch (e: any) {
      console.error(e);
      alert("Execution error: " + e.message);
    } finally {
      setIsRunning(false);
    }
  };

  const handleStop = () => {
    setIsPlaying(false);
    setMode('edit');
  };

  const togglePlay = () => setIsPlaying(p => !p);

  // Playback Loop
  useEffect(() => {
    if (isPlaying) {
      playIntervalRef.current = setInterval(() => {
        setCurrentStep(prev => {
          if (prev >= trace.length - 1) {
            setIsPlaying(false);
            return prev;
          }
          return prev + 1;
        });
      }, speed);
    } else {
      if (playIntervalRef.current) clearInterval(playIntervalRef.current);
    }
    
    return () => {
      if (playIntervalRef.current) clearInterval(playIntervalRef.current);
    };
  }, [isPlaying, speed, trace.length]);

  // Derived state for the UI
  const currentSnapshot = trace[currentStep];
  const prevSnapshot = currentStep > 0 ? trace[currentStep - 1] : null;

  const topFrameVariables = currentSnapshot?.callStack[currentSnapshot.callStack.length - 1]?.variables || {};

  const getChangedVariables = (frameIndex: number) => {
    const changed = new Set<string>();
    if (!currentSnapshot || !prevSnapshot) return changed;
    
    const currFrame = currentSnapshot.callStack[frameIndex];
    const prevFrame = prevSnapshot.callStack[frameIndex];
    
    if (currFrame && prevFrame && currFrame.name === prevFrame.name) {
      for (const [k, v] of Object.entries(currFrame.variables)) {
        if (prevFrame.variables[k] !== v) {
          changed.add(k);
        }
      }
    }
    return changed;
  };

  return (
    <div className="flex flex-col h-screen bg-[#0d1117] text-[#c9d1d9] font-sans overflow-hidden">
      {/* Header */}
      <nav className="h-12 border-b border-[#30363d] flex items-center justify-between px-4 bg-[#161b22]">
        <div className="flex items-center gap-4">
          <div className="flex gap-1">
            <div className="w-3 h-3 rounded-full bg-[#ff5f56]"></div>
            <div className="w-3 h-3 rounded-full bg-[#ffbd2e]"></div>
            <div className="w-3 h-3 rounded-full bg-[#27c93f]"></div>
          </div>
          <div className="h-4 w-px bg-[#30363d] mx-2"></div>
          <span className="text-sm font-semibold text-white tracking-tight">
            AlgoLens IDE <span className="text-[#8b949e] font-normal italic px-1 text-xs">v2.0 Beta</span>
          </span>
        </div>
        
        <div className="flex bg-[#0d1117] rounded-md border border-[#30363d] p-1 gap-1">
          <button
            onClick={() => { setLanguage('javascript'); setMode('edit'); }}
            disabled={mode === 'playback'}
            className={cn(
              "px-3 py-1 text-xs rounded transition-colors disabled:opacity-50",
              language === 'javascript' ? "bg-[#21262d] text-white shadow-sm" : "text-[#8b949e] hover:text-white"
            )}
          >
            JavaScript
          </button>
          <button
            onClick={() => { setLanguage('python'); setMode('edit'); }}
            disabled={mode === 'playback'}
            className={cn(
              "px-3 py-1 text-xs rounded transition-colors disabled:opacity-50",
              language === 'python' ? "bg-[#21262d] text-white shadow-sm" : "text-[#8b949e] hover:text-white"
            )}
          >
            Python {language === 'python' && !pyodideReady && <Loader2 size={12} className="inline animate-spin ml-1" />}
          </button>
        </div>
        
        <div className="flex items-center gap-3">
          {mode === 'edit' ? (
            <div
              onClick={!isRunning && (language !== 'python' || pyodideReady) ? handleRun : undefined}
              className={cn(
                "flex items-center gap-2 px-2 py-1 bg-[#238636] rounded text-white text-xs font-medium shadow-lg shadow-green-900/20 transition-all",
                (isRunning || (language === 'python' && !pyodideReady)) ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:bg-[#2ea043]"
              )}
            >
              <span>{isRunning ? 'Running...' : 'Run Visualizer'}</span>
              {!isRunning && (
                <svg className="w-3 h-3 fill-current" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
              )}
              {isRunning && <Loader2 size={12} className="animate-spin" />}
            </div>
          ) : (
            <>
              <div
                onClick={() => {
                  setCurrentStep(0);
                  setIsPlaying(false);
                }}
                className="flex items-center gap-2 px-2 py-1 bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] text-white text-xs font-medium rounded transition-all cursor-pointer"
              >
                <RotateCcw size={12} />
                <span>Reset</span>
              </div>
              <div
                onClick={handleStop}
                className="flex items-center gap-2 px-2 py-1 bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] text-white text-xs font-medium rounded transition-all cursor-pointer"
              >
                <Code2 size={12} />
                <span>Edit Code</span>
              </div>
            </>
          )}
        </div>
      </nav>

      {/* Main Layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <aside className="w-12 bg-[#161b22] border-r border-[#30363d] flex flex-col items-center py-4 gap-6 shrink-0">
          <div className="text-[#c9d1d9]">
            <svg className="w-6 h-6 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>
          </div>
          <div className="text-blue-400">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg>
          </div>
          <div className="text-[#c9d1d9] opacity-40">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          </div>
        </aside>

        {/* Editor Panel */}
        <section className="flex-1 lg:max-w-[600px] xl:max-w-[700px] flex flex-col border-r border-[#30363d] relative min-w-0">
          <div className="flex items-center gap-px bg-[#161b22] text-xs">
            <div className="px-4 py-2 bg-[#0d1117] border-t border-[#f78166] text-white flex items-center gap-2">
              <span className="text-[#3fb950] font-bold">{language === 'python' ? 'PY' : 'JS'}</span>
              {language === 'python' ? 'main.py' : 'main.js'}
            </div>
          </div>
          <div className="flex-1 relative bg-[#0d1117]">
            <Editor
              height="100%"
              language={language}
              theme="vs-dark"
              value={currentCode}
              onChange={(val) => {
                setCode(val || '');
                if (editorRef.current && monaco) {
                  monaco.editor.setModelMarkers(editorRef.current.getModel(), 'owner', []);
                }
              }}
              onMount={handleEditorDidMount}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                readOnly: mode === 'playback',
                padding: { top: 16 },
                scrollBeyondLastLine: false,
                smoothScrolling: true,
                cursorBlinking: mode === 'playback' ? 'solid' : 'blink',
                renderLineHighlight: mode === 'playback' ? 'none' : 'all',
                guides: { indentation: true, bracketPairs: true },
              }}
            />
            {mode === 'playback' && (
              <div className="absolute inset-0 pointer-events-none bg-[#010409]/10" />
            )}
          </div>
        </section>

        {/* Trace / Visualizer Panel */}
        <section className="flex-1 flex flex-col bg-[#010409] min-w-0">
          {mode === 'edit' ? (
            <div className="flex-1 flex flex-col items-center justify-center text-[#8b949e] p-8 text-center gap-4">
              <Terminal size={48} className="opacity-20" />
              <p className="text-sm">Write your DSA logic on the left and click <strong className="text-white">Run Visualizer</strong> to trace execution.</p>
            </div>
          ) : (
            <div className="flex-1 flex flex-col h-full overflow-hidden">
              <div className="p-6 flex flex-col gap-8 flex-1 overflow-y-auto">
                <div className="space-y-4 flex-1 flex flex-col">
                  <div className="flex justify-between items-center shrink-0">
                    <h3 className="text-xs font-bold text-[#8b949e] uppercase tracking-widest">Data Structure Visualization</h3>
                    {currentSnapshot?.evalContext && (
                      <span className="text-[11px] font-mono text-[#ff7b72] bg-[#ff7b72]/10 px-2 py-0.5 rounded border border-[#ff7b72]/20">
                        {currentSnapshot.evalContext}
                      </span>
                    )}
                  </div>
                  <div className="flex-1 min-h-[160px] border border-[#30363d] rounded-lg bg-[#0d1117] overflow-hidden">
                    {Object.keys(topFrameVariables).length === 0 ? (
                      <div className="flex justify-center items-center h-full">
                        <span className="text-[#8b949e] text-xs italic">No local variables to visualize</span>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-6 p-4 items-start content-start overflow-y-auto h-full">
                        {Object.entries(topFrameVariables).map(([name, valStr]) => {
                          let parsed = null;
                          let type = 'primitive';
                          try {
                            const jsonStr = String(valStr).replace(/'/g, '"').replace(/\(/g, '[').replace(/\)/g, ']');
                            parsed = JSON.parse(jsonStr);
                            if (Array.isArray(parsed)) type = 'array';
                            else if (parsed !== null && typeof parsed === 'object') type = 'object';
                          } catch {
                            type = 'primitive';
                          }

                          return (
                            <div key={name} className="flex flex-col gap-2">
                              <span className="text-[11px] text-[#8b949e] font-mono">{name}</span>
                              {type === 'array' ? (
                                <div className="flex gap-1 flex-wrap">
                                  {parsed.map((item: any, i: number) => (
                                    <div key={i} className="flex flex-col items-center gap-1">
                                      <div className="min-w-[40px] h-10 px-2 flex items-center justify-center bg-[#161b22] border border-[#30363d] rounded text-xs text-[#c9d1d9] font-mono">
                                        {String(item)}
                                      </div>
                                      <span className="text-[9px] text-[#484f58]">{i}</span>
                                    </div>
                                  ))}
                                </div>
                              ) : type === 'object' ? (
                                <div className="flex flex-col gap-1 border border-[#30363d] rounded bg-[#161b22] p-2 min-w-[120px]">
                                  {Object.entries(parsed).length === 0 ? (
                                    <span className="text-[#8b949e] text-xs italic">empty</span>
                                  ) : (
                                    Object.entries(parsed).map(([k, v]) => (
                                      <div key={k} className="flex justify-between gap-4 text-xs font-mono border-b border-[#30363d]/50 last:border-0 pb-1 last:pb-0">
                                        <span className="text-[#79c0ff]">{k}</span>
                                        <span className="text-[#c9d1d9]">{String(v as any)}</span>
                                      </div>
                                    ))
                                  )}
                                </div>
                              ) : (
                                <div className="px-3 py-1.5 bg-[#161b22] border border-[#30363d] rounded text-xs text-[#c9d1d9] font-mono whitespace-pre-wrap max-w-[200px]">
                                  {valStr}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 mt-4">
                  {/* Call Stack */}
                  <div className="bg-[#161b22] rounded-lg border border-[#30363d] p-4 flex flex-col gap-3">
                    <h4 className="text-[11px] font-bold text-[#8b949e] uppercase tracking-wider">Call Stack</h4>
                    <div className="flex flex-col gap-2 font-mono text-xs overflow-y-auto max-h-[150px]">
                      {currentSnapshot?.callStack.map((frame, idx) => {
                        const isTop = idx === currentSnapshot.callStack.length - 1;
                        return (
                          <div 
                            key={idx}
                            className={cn(
                              "p-2 rounded flex justify-between",
                              isTop 
                                ? "bg-blue-500/10 border border-blue-500/30 text-white" 
                                : "bg-[#0d1117] border border-[#30363d] opacity-50 text-[#8b949e]"
                            )}
                          >
                            <span>{frame.name}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Standard Output */}
                  <div className="bg-[#161b22] rounded-lg border border-[#30363d] p-4 flex flex-col gap-3">
                    <h4 className="text-[11px] font-bold text-[#8b949e] uppercase tracking-wider">Standard Output</h4>
                    <div className="flex-1 min-h-[100px] border border-[#30363d] rounded bg-[#0d1117] p-2 overflow-y-auto font-mono text-xs text-[#c9d1d9] whitespace-pre-wrap">
                      {currentSnapshot?.output && currentSnapshot.output.length > 0 ? (
                        currentSnapshot.output.join('\n')
                      ) : (
                        <span className="text-[#8b949e] italic">No output yet</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 mt-0">
                  {/* Variables */}
                  <div className="bg-[#161b22] rounded-lg border border-[#30363d] p-4 flex flex-col gap-3 col-span-2">
                    <h4 className="text-[11px] font-bold text-[#8b949e] uppercase tracking-wider">Variables</h4>
                    <div className="flex flex-col gap-2 font-mono text-xs overflow-y-auto max-h-[150px]">
                      {currentSnapshot?.callStack[currentSnapshot.callStack.length - 1]?.variables && 
                        Object.entries(currentSnapshot.callStack[currentSnapshot.callStack.length - 1].variables).length > 0 ? (
                          Object.entries(currentSnapshot.callStack[currentSnapshot.callStack.length - 1].variables).map(([name, val]) => {
                            const changedVars = getChangedVariables(currentSnapshot.callStack.length - 1);
                            const isChanged = changedVars.has(name);
                            return (
                              <div 
                                key={name} 
                                className={cn(
                                  "flex justify-between px-1 rounded py-0.5",
                                  isChanged ? "bg-amber-400/20" : ""
                                )}
                              >
                                <span className={isChanged ? "text-amber-400 font-bold" : "text-[#c9d1d9]"}>{name}</span>
                                <span className="text-[#79c0ff] truncate max-w-[100px]" title={String(val)}>{val}</span>
                              </div>
                            );
                          })
                        ) : (
                          <div className="text-[#8b949e] italic text-xs">No local variables</div>
                        )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Playback Controls & Console Footer */}
              <footer className="h-auto md:h-52 lg:h-44 bg-[#010409] border-t border-[#30363d] flex flex-col shrink-0">
                <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
                  <div className="w-full md:w-[50%] lg:w-[400px] h-32 md:h-auto border-b md:border-b-0 md:border-r border-[#30363d] p-3 md:p-4 font-mono text-[10px] sm:text-xs text-[#8b949e] overflow-y-auto flex flex-col gap-1 shrink-0">
                    <div className="text-[#3fb950] mb-1">[Console Output]</div>
                    {currentSnapshot && currentSnapshot.output.length > 0 ? (
                      currentSnapshot.output.map((line, i) => (
                        <div key={i} className="text-white">{line}</div>
                      ))
                    ) : (
                      <div className="italic opacity-50">No output yet...</div>
                    )}
                    {isPlaying && <div className="animate-pulse inline-block w-1 h-3 bg-[#c9d1d9] ml-1 mt-1"></div>}
                  </div>
                  
                  <div className="flex-1 flex flex-col px-4 py-3 md:px-6 md:py-4 overflow-y-auto min-w-0 justify-between gap-2">
                    <div className="flex justify-between items-center mb-1 gap-2">
                      <span className="text-[10px] md:text-[11px] font-bold text-[#8b949e] uppercase tracking-wider truncate">Playback Controls</span>
                      <span className="text-[10px] md:text-xs text-blue-400 whitespace-nowrap">Step {currentStep} / {Math.max(0, trace.length - 1)}</span>
                    </div>
                    
                    <div className="mb-2 md:mb-4 mt-1 md:mt-0">
                      <input
                        type="range"
                        min={0}
                        max={Math.max(0, trace.length - 1)}
                        value={currentStep}
                        onChange={(e) => {
                          setIsPlaying(false);
                          setCurrentStep(Number(e.target.value));
                        }}
                        className="w-full h-1.5 bg-[#30363d] rounded-full appearance-none cursor-pointer accent-blue-500"
                      />
                    </div>
                    
                    <div className="flex items-center justify-center gap-4 md:gap-6">
                      <button 
                        onClick={() => { setIsPlaying(false); setCurrentStep(p => Math.max(0, p - 1)); }}
                        disabled={currentStep === 0}
                        className="p-1 md:p-2 text-[#8b949e] hover:text-white disabled:opacity-30 shrink-0"
                      >
                        <svg className="w-4 h-4 md:w-5 md:h-5 fill-current" viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
                      </button>
                      <button 
                        onClick={togglePlay}
                        className="w-10 h-10 md:w-12 md:h-12 bg-white text-black rounded-full flex items-center justify-center shadow-lg hover:scale-105 transition-transform shrink-0"
                      >
                        {isPlaying ? <Pause size={18} className="fill-current md:w-6 md:h-6" /> : <svg className="w-5 h-5 md:w-6 md:h-6 fill-current" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>}
                      </button>
                      <button 
                        onClick={() => { setIsPlaying(false); setCurrentStep(p => Math.min(trace.length - 1, p + 1)); }}
                        disabled={currentStep === trace.length - 1}
                        className="p-1 md:p-2 text-[#8b949e] hover:text-white disabled:opacity-30 shrink-0"
                      >
                        <svg className="w-4 h-4 md:w-5 md:h-5 fill-current" viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
                      </button>
                    </div>
                    
                    <div className="mt-3 md:mt-4 flex items-center gap-2 md:gap-4 max-w-[300px] mx-auto w-full">
                      <span className="text-[9px] md:text-[10px] text-[#484f58] uppercase">Speed</span>
                      <div className="flex-1 relative flex items-center h-4">
                        <input
                          type="range"
                          min={50}
                          max={1000}
                          step={50}
                          value={1050 - speed}
                          onChange={(e) => setSpeed(1050 - Number(e.target.value))}
                          className="w-full h-1 bg-[#30363d] rounded-full appearance-none cursor-pointer accent-blue-500"
                        />
                      </div>
                      <span className="text-[9px] md:text-[10px] text-[#8b949e] min-w-[32px] text-right font-mono">
                        {speed === 50 ? 'Turbo' : speed === 200 ? 'Fast' : speed === 500 ? '1.0x' : 'Slow'}
                      </span>
                    </div>
                  </div>
                </div>
                
                <div className="h-6 bg-[#0d1117] flex items-center px-4 justify-between border-t border-[#30363d] text-[9px] md:text-[10px] text-[#8b949e] shrink-0">
                  <div className="flex gap-4">
                    <span>Line {currentSnapshot?.line || 1}</span>
                    <span>Spaces: 4</span>
                    <span>UTF-8</span>
                  </div>
                  <div className="flex gap-4">
                    <span>{language === 'javascript' ? 'Node (JS)' : 'Python 3.10 (Pyodide)'}</span>
                    <span className="text-[#3fb950] flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-[#3fb950]"></span> Ready
                    </span>
                  </div>
                </div>
              </footer>
            </div>
          )}
        </section>
      </div>

      {/* Test Case Auto-Injector Modal */}
      {pendingTest && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-6 w-[450px] shadow-2xl shadow-black">
            <h2 className="text-white font-bold text-lg mb-2">Run {pendingTest.funcName}</h2>
            <p className="text-xs text-[#8b949e] mb-5 leading-relaxed">
              No function call was detected in your code. Provide the arguments below to automatically inject a test case.
            </p>
            
            <div className="space-y-4 mb-8">
              {pendingTest.args.map(arg => (
                <div key={arg.name}>
                  <label className="block text-xs font-bold text-[#c9d1d9] mb-1.5 font-mono">
                    {arg.name}
                    {arg.type && <span className="text-blue-400 font-normal ml-1">: {arg.type}</span>}
                  </label>
                  <input 
                    type="text" 
                    className="w-full bg-[#0d1117] border border-[#30363d] rounded-md p-2.5 text-sm text-white font-mono focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none transition-all"
                    placeholder={
                      arg.type.includes('List') ? "e.g. [1, 2, 3]" :
                      arg.type.includes('str') ? "e.g. 'hello'" :
                      arg.type.includes('int') ? "e.g. 42" :
                      arg.type.includes('bool') ? "e.g. True" :
                      language === 'python' ? "e.g. [1, 2, 3] or 'hello'" : "e.g. [1, 2, 3] or \"hello\""
                    }
                    value={testInputs[arg.name] || ''}
                    onChange={e => setTestInputs({...testInputs, [arg.name]: e.target.value})}
                  />
                </div>
              ))}
              {pendingTest.args.length === 0 && (
                <div className="text-sm text-[#8b949e] italic p-3 bg-[#0d1117] rounded border border-[#30363d]/50">
                  This function takes no arguments.
                </div>
              )}
            </div>
            
            <div className="flex justify-end gap-3">
              <button 
                onClick={() => { setPendingTest(null); setTestInputs({}); }}
                className="px-4 py-2 text-xs font-semibold text-[#8b949e] hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={() => {
                  const className = (pendingTest as any).className || 'Solution';
                  const argsList = pendingTest.args.map(arg => testInputs[arg.name] || (language === 'python' ? 'None' : 'null')).join(', ');
                  let callStr = '';
                  if (language === 'python') {
                    callStr = pendingTest.isClass 
                      ? `print("Result:", ${className}().${pendingTest.funcName}(${argsList}))`
                      : `print("Result:", ${pendingTest.funcName}(${argsList}))`;
                  } else {
                    callStr = pendingTest.isClass
                      ? `console.log("Result:", new ${className}().${pendingTest.funcName}(${argsList}));`
                      : `console.log("Result:", ${pendingTest.funcName}(${argsList}));`;
                  }
                  
                  const newCode = currentCode.trim() + '\n\n' + callStr;
                  setCode(newCode);
                  setPendingTest(null);
                  setTestInputs({});
                  
                  // Run immediately with the new code
                  handleRun(newCode);
                }}
                className="px-5 py-2 bg-[#238636] hover:bg-[#2ea043] text-white text-xs font-bold rounded-md shadow-sm transition-all"
              >
                Inject & Run
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

