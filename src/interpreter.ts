import { parse } from 'acorn';

class ReturnError extends Error {
    constructor(public value: any) { super(); }
}
class BreakError extends Error {}
class ContinueError extends Error {}

export interface TraceSnapshot {
    line: number;
    callStack: { name: string; variables: Record<string, string> }[];
    output: string[];
    evalContext?: string;
}

export interface ExecutionResult {
    trace: TraceSnapshot[];
    error?: string;
    line?: number;
}

export function executeJS(code: string): ExecutionResult {
    let ast;
    try {
        ast = parse(code, { locations: true, ecmaVersion: 2020 });
    } catch (e: any) {
        return { trace: [], error: String(e.message || e), line: e.loc?.line };
    }
    const trace: TraceSnapshot[] = [];
    const output: string[] = [];
    
    class Environment {
        constructor(public parent: Environment | null, public name: string) {}
        variables = new Map<string, any>();
        
        get(name: string): any {
            if (this.variables.has(name)) return this.variables.get(name);
            if (this.parent) return this.parent.get(name);
            if (name === 'console') return { log: (...args: any[]) => output.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')) };
            if (name === 'Math') return Math;
            throw new Error(`Variable ${name} not found`);
        }
        
        set(name: string, value: any) {
            if (this.variables.has(name)) {
                this.variables.set(name, value);
                return;
            }
            if (this.parent) {
                this.parent.set(name, value);
                return;
            }
            throw new Error(`Variable ${name} not found`);
        }
        
        declare(name: string, value: any) {
            this.variables.set(name, value);
        }
    }
    
    let currentEnv = new Environment(null, 'global');
    
    class ListNode {
        val: number;
        next: ListNode | null;
        constructor(val: number = 0, next: ListNode | null = null) {
            this.val = val;
            this.next = next;
        }
    }
    class TreeNode {
        val: number;
        left: TreeNode | null;
        right: TreeNode | null;
        constructor(val: number = 0, left: TreeNode | null = null, right: TreeNode | null = null) {
            this.val = val;
            this.left = left;
            this.right = right;
        }
    }
    currentEnv.declare('ListNode', ListNode);
    currentEnv.declare('TreeNode', TreeNode);

    let stepCount = 0;
    const MAX_STEPS = 2000;
    
    function snapshot(node: any, evalContext?: string) {
        if (!node.loc) return;
        
        stepCount++;
        if (stepCount > MAX_STEPS) {
            throw new Error("Execution stopped: maximum trace steps exceeded (potential infinite loop).");
        }
        
        const callStack: { name: string; variables: Record<string, string> }[] = [];
        let env: Environment | null = currentEnv;
        while (env) {
            const vars: Record<string, string> = {};
            for (const [k, v] of env.variables.entries()) {
                if (typeof v === 'function' || k === 'console' || k === 'Math') continue;
                try {
                    vars[k] = JSON.stringify(v);
                } catch {
                    vars[k] = String(v);
                }
            }
            callStack.unshift({ name: env.name, variables: vars });
            env = env.parent;
        }
        trace.push({
            line: node.loc.start.line,
            callStack,
            output: [...output],
            evalContext
        });
    }

    function evaluate(node: any, isStatement = false): any {
        if (!node) return undefined;
        
        // Take snapshot before statements, except blocks which are just containers, and handle conditionals differently
        if (isStatement && node.type !== 'BlockStatement' && node.type !== 'FunctionDeclaration' && node.type !== 'IfStatement' && node.type !== 'WhileStatement' && node.type !== 'ForStatement') {
            snapshot(node);
        }

        switch (node.type) {
            case 'Program':
            case 'BlockStatement':
                let res;
                for (const stmt of node.body) {
                    res = evaluate(stmt, true);
                }
                return res;
            case 'VariableDeclaration':
                for (const decl of node.declarations) {
                    const value = decl.init ? evaluate(decl.init) : undefined;
                    currentEnv.declare(decl.id.name, value);
                }
                return;
            case 'FunctionDeclaration':
                const fn = function(...args: any[]) {
                    const prevEnv = currentEnv;
                    currentEnv = new Environment(prevEnv, node.id.name);
                    for (let i = 0; i < node.params.length; i++) {
                        currentEnv.declare(node.params[i].name, args[i]);
                    }
                    try {
                        evaluate(node.body);
                    } catch (e) {
                        if (e instanceof ReturnError) return e.value;
                        throw e;
                    } finally {
                        currentEnv = prevEnv;
                    }
                };
                currentEnv.declare(node.id.name, fn);
                return;
            case 'ArrowFunctionExpression':
                return function(...args: any[]) {
                    const prevEnv = currentEnv;
                    currentEnv = new Environment(prevEnv, 'anonymous');
                    for (let i = 0; i < node.params.length; i++) {
                        currentEnv.declare(node.params[i].name, args[i]);
                    }
                    try {
                        if (node.body.type === 'BlockStatement') {
                            evaluate(node.body);
                        } else {
                            return evaluate(node.body);
                        }
                    } catch (e) {
                        if (e instanceof ReturnError) return e.value;
                        throw e;
                    } finally {
                        currentEnv = prevEnv;
                    }
                };
            case 'ExpressionStatement':
                return evaluate(node.expression);
            case 'ReturnStatement':
                snapshot(node); // Snapshot exactly on return
                throw new ReturnError(node.argument ? evaluate(node.argument) : undefined);
            case 'IfStatement': {
                const test = evaluate(node.test);
                snapshot(node, `Condition evaluates to: ${test}`);
                if (test) {
                    evaluate(node.consequent, true);
                } else if (node.alternate) {
                    evaluate(node.alternate, true);
                }
                return;
            }
            case 'WhileStatement':
                while (true) {
                    const test = evaluate(node.test);
                    snapshot(node, `Condition evaluates to: ${test}`);
                    if (!test) break;
                    try {
                        evaluate(node.body, true);
                    } catch (e) {
                        if (e instanceof BreakError) break;
                        if (e instanceof ContinueError) continue;
                        throw e;
                    }
                }
                return;
            case 'ForStatement':
                const prevEnvFor = currentEnv;
                currentEnv = new Environment(currentEnv, currentEnv.name);
                if (node.init) evaluate(node.init, true);
                while (true) {
                    let test = true;
                    if (node.test) {
                        test = evaluate(node.test);
                        snapshot(node, `Condition evaluates to: ${test}`);
                    } else {
                        snapshot(node);
                    }
                    if (!test) break;
                    
                    try {
                        evaluate(node.body, true);
                    } catch (e) {
                        if (e instanceof BreakError) break;
                        if (e instanceof ContinueError) {
                            if (node.update) evaluate(node.update);
                            continue;
                        }
                        throw e;
                    }
                    if (node.update) evaluate(node.update);
                }
                currentEnv = prevEnvFor;
                return;
            case 'AssignmentExpression':
                const val = evaluate(node.right);
                if (node.left.type === 'Identifier') {
                    if (node.operator === '=') currentEnv.set(node.left.name, val);
                    else if (node.operator === '+=') currentEnv.set(node.left.name, currentEnv.get(node.left.name) + val);
                    else if (node.operator === '-=') currentEnv.set(node.left.name, currentEnv.get(node.left.name) - val);
                } else if (node.left.type === 'MemberExpression') {
                    const obj = evaluate(node.left.object);
                    const prop = node.left.computed ? evaluate(node.left.property) : node.left.property.name;
                    if (node.operator === '=') obj[prop] = val;
                    else if (node.operator === '+=') obj[prop] += val;
                    else if (node.operator === '-=') obj[prop] -= val;
                }
                return val;
            case 'BinaryExpression':
                const l = evaluate(node.left);
                const r = evaluate(node.right);
                switch (node.operator) {
                    case '+': return l + r;
                    case '-': return l - r;
                    case '*': return l * r;
                    case '/': return l / r;
                    case '%': return l % r;
                    case '==': return l == r;
                    case '===': return l === r;
                    case '!=': return l != r;
                    case '!==': return l !== r;
                    case '<': return l < r;
                    case '<=': return l <= r;
                    case '>': return l > r;
                    case '>=': return l >= r;
                }
                return;
            case 'LogicalExpression':
                if (node.operator === '&&') return evaluate(node.left) && evaluate(node.right);
                if (node.operator === '||') return evaluate(node.left) || evaluate(node.right);
                return;
            case 'UnaryExpression':
                const arg = evaluate(node.argument);
                if (node.operator === '!') return !arg;
                if (node.operator === '-') return -arg;
                return;
            case 'Identifier':
                return currentEnv.get(node.name);
            case 'Literal':
                return node.value;
            case 'ArrayExpression':
                return node.elements.map((e: any) => evaluate(e));
            case 'ObjectExpression':
                const obj: any = {};
                for (const prop of node.properties) {
                    const key = prop.key.type === 'Identifier' ? prop.key.name : evaluate(prop.key);
                    obj[key] = evaluate(prop.value);
                }
                return obj;
            case 'MemberExpression':
                const mObj = evaluate(node.object);
                const mProp = node.computed ? evaluate(node.property) : node.property.name;
                if (typeof mObj[mProp] === 'function') {
                    return mObj[mProp].bind(mObj);
                }
                return mObj[mProp];
            case 'CallExpression':
                const callee = evaluate(node.callee);
                const args = node.arguments.map((a: any) => evaluate(a));
                return callee(...args);
            case 'UpdateExpression':
                let uVal;
                if (node.argument.type === 'Identifier') {
                    uVal = currentEnv.get(node.argument.name);
                    const newVal = node.operator === '++' ? uVal + 1 : uVal - 1;
                    currentEnv.set(node.argument.name, newVal);
                } else if (node.argument.type === 'MemberExpression') {
                    const obj = evaluate(node.argument.object);
                    const prop = node.argument.computed ? evaluate(node.argument.property) : node.argument.property.name;
                    uVal = obj[prop];
                    const newVal = node.operator === '++' ? uVal + 1 : uVal - 1;
                    obj[prop] = newVal;
                }
                return node.prefix ? (node.operator === '++' ? uVal + 1 : uVal - 1) : uVal;
            default:
                // Fallback for unsupported nodes
                return undefined;
        }
    }
    
    try {
        evaluate(ast, true);
    } catch (e: any) {
        if (!(e instanceof ReturnError)) {
            console.error(e);
            output.push(String(e.message || e));
            return { trace, error: String(e.message || e) };
        }
    }
    
    return { trace };
}
