// ============================================================
// MapleCAS – Computer Algebra System  (main application logic)
// ============================================================
//
// Sections:
//   1. Configuration
//   2. Python Bridge Code  (embedded string → runs inside Pyodide)
//   3. PyodideManager      (loads Pyodide + SymEngine wheel)
//   4. CellManager         (creates / manages math cells)
//   5. PaletteManager      (left-sidebar symbol insertion)
//   6. ContextPanel        (right-sidebar dynamic actions)
//   7. Initialization
//
// ============================================================

(function () {
  "use strict";

  // ----------------------------------------------------------
  // 1.  CONFIGURATION
  // ----------------------------------------------------------
  const CFG = {
    // Pyodide CDN that ships Python 3.12  (matches the cp312 wheel)
    PYODIDE_INDEX: "https://cdn.jsdelivr.net/pyodide/v0.26.2/full/",
    // Local pre-compiled SymEngine wheel (relative to page)
    SYMENGINE_WHEEL:
      "./lib/symengine-0.14.1-cp312-cp312-pyodide_2024_0_wasm32.whl",
  };

  // ----------------------------------------------------------
  // 2.  PYTHON BRIDGE CODE  (MathJSON ⇄ SymEngine)
  // ----------------------------------------------------------
  // This Python source is loaded once into Pyodide.  It exposes
  // two public functions callable from JS:
  //   • evaluate(json_str, operation)  → JSON result string
  //   • evaluate_string(expr, op)      → JSON result string (fallback)
  // ----------------------------------------------------------

  const PYTHON_BRIDGE = `
###############################################################
# bridge.py v3 – MathJSON -> SymEngine evaluation bridge
# Handles CortexJS Compute Engine MathJSON format
###############################################################
import json, traceback

import symengine as _se
from symengine import (
    Symbol   as _Symbol,
    Integer  as _Integer,
    Rational as _Rational,
    Float    as _Float,
    Add      as _Add,
    Mul      as _Mul,
    Pow      as _Pow,
    sin, cos, tan, exp, log, sqrt,
    pi, E, I, oo,
    diff    as _diff,
    expand  as _expand,
)
try:
    from symengine.lib.symengine_wrapper import solve as _raw_solve
except ImportError:
    _raw_solve = None

try:
    from symengine import asin, acos, atan
except ImportError:
    asin = acos = atan = None

# Backslash constant
_BS = chr(92)

# ── Caches and state ────────────────────────────────────────
_sym_cache = {}
_USER_FUNCS = {}   # name -> (param_symbol, body_expr)
_USER_VARS  = {}   # name -> expr

def _sym(name):
    if name not in _sym_cache:
        _sym_cache[name] = _Symbol(name)
    return _sym_cache[name]

_CONST = {
    "Pi": pi, "pi": pi,
    "ExponentialE": E, "e": E,
    "ImaginaryUnit": I,
    "Infinity": oo, "PositiveInfinity": oo,
    "NegativeInfinity": -oo,
    "Nothing": _Integer(0),
    "Half": _Rational(1, 2),
    "True": _Integer(1), "False": _Integer(0),
}

# ── Integration (custom – SymEngine lacks top-level integrate) ──
def _integrate(expr, var):
    expr = _expand(expr)
    if isinstance(expr, _Add):
        r = _Integer(0)
        for a in expr.args:
            r = r + _integrate(a, var)
        return r
    if isinstance(expr, _Mul):
        const_part = _Integer(1)
        rest = _Integer(1)
        for a in expr.args:
            if var not in a.free_symbols:
                const_part = const_part * a
            else:
                rest = rest * a
        return const_part * _integrate(rest, var)
    if isinstance(expr, _Pow):
        base, ex = expr.args
        if base == var and var not in ex.free_symbols:
            if ex == _Integer(-1):
                return log(var)
            n1 = ex + _Integer(1)
            return var ** n1 / n1
        if base == E and ex == var:
            return exp(var)
        if base == E:
            ex_exp = _expand(ex)
            if isinstance(ex_exp, _Mul):
                k = _Integer(1)
                has_var = False
                for a in ex_exp.args:
                    if var in a.free_symbols:
                        if a == var:
                            has_var = True
                        else:
                            raise ValueError(f"Cannot integrate {expr} w.r.t. {var}")
                    else:
                        k = k * a
                if has_var and k != _Integer(0):
                    return exp(ex) / k
    if expr == var:
        return var ** _Integer(2) / _Integer(2)
    if var not in expr.free_symbols:
        return expr * var
    if isinstance(expr, sin) and expr.args[0] == var:
        return -cos(var)
    if isinstance(expr, cos) and expr.args[0] == var:
        return sin(var)
    raise ValueError(f"Cannot integrate {expr} w.r.t. {var}")

# ── Solve ────────────────────────────────────────────────────
def _solve(expr, var):
    if _raw_solve is None:
        raise NotImplementedError("solve not available in this build")
    result = _raw_solve(expr, var)
    if hasattr(result, "args"):
        return list(result.args)
    return [result]

# ── Finite Sum ───────────────────────────────────────────────
def _finite_sum(body_expr, var, lo, hi):
    """Evaluate sum_{var=lo}^{hi} body_expr by substitution."""
    lo_int = int(lo)
    hi_int = int(hi)
    result = _Integer(0)
    var_str = str(var)
    for i in range(lo_int, hi_int + 1):
        subs_dict = {var: _Integer(i)}
        for fs in body_expr.free_symbols:
            fs_str = str(fs)
            if "_" + var_str in fs_str:
                subs_dict[fs] = _Symbol(fs_str.replace("_" + var_str, "_" + str(i)))
        term = body_expr.subs(subs_dict)
        result = result + term
    return result

# ── Finite Product ───────────────────────────────────────────
def _finite_product(body_expr, var, lo, hi):
    """Evaluate prod_{var=lo}^{hi} body_expr by substitution."""
    lo_int = int(lo)
    hi_int = int(hi)
    result = _Integer(1)
    var_str = str(var)
    for i in range(lo_int, hi_int + 1):
        subs_dict = {var: _Integer(i)}
        for fs in body_expr.free_symbols:
            fs_str = str(fs)
            if "_" + var_str in fs_str:
                subs_dict[fs] = _Symbol(fs_str.replace("_" + var_str, "_" + str(i)))
        term = body_expr.subs(subs_dict)
        result = result * term
    return result

# ── MathJSON -> SymEngine converter ──────────────────────────
def to_se(node):
    if node is None or node == "Nothing":
        return _Integer(0)
    if isinstance(node, bool):
        return _Integer(1 if node else 0)
    if isinstance(node, int):
        return _Integer(node)
    if isinstance(node, float):
        return _Float(node)
    if isinstance(node, str):
        # Skip CortexJS delimiter annotations like "'[]'"
        if node.startswith("'") or node.startswith('"') or node in ("'[]'", '"[]"', "'()'", "'||'"):
            return _Integer(0)
        if node in _USER_VARS:
            return _USER_VARS[node]
        return _CONST.get(node, _sym(node))
    if isinstance(node, dict):
        if "num" in node:
            s = str(node["num"])
            if "/" in s:
                n, d = s.split("/", 1)
                return _Rational(int(n), int(d))
            if "." in s:
                return _Float(float(s))
            return _Integer(int(s))
        if "sym" in node:
            name = node["sym"]
            if name in _USER_VARS:
                return _USER_VARS[name]
            return _CONST.get(name, _sym(name))
        if "fn" in node:
            fn = node["fn"]
            if isinstance(fn, list) and len(fn) > 0:
                return _apply(fn[0], fn[1:])
        if "str" in node:
            return _sym(node["str"])
        return _Integer(0)
    if isinstance(node, list):
        if len(node) == 0:
            return _Integer(0)
        head, *tail = node
        if isinstance(head, str):
            return _apply(head, tail)
        return to_se(head)
    return _Integer(0)

def _extract_function(node):
    """Extract (param_symbols_list, body_expr) from a Function MathJSON node."""
    if not isinstance(node, list) or len(node) < 2 or node[0] != "Function":
        return None
    body_node = node[1]
    
    params = []
    if len(node) > 2:
        for p in node[2:]:
            if isinstance(p, str):
                params.append(_sym(p))
            elif isinstance(p, dict) and "sym" in p:
                params.append(_sym(p["sym"]))
    else:
        params = [_sym("x")]
        
    body = to_se(body_node)
    return (params, body)

def _parse_limits(node):
    """Parse a Limits MathJSON node: ['Limits', var, lo, hi] -> (var_sym, lo_expr, hi_expr)."""
    if not isinstance(node, list) or node[0] != "Limits":
        return None
    var = _sym("x")
    lo = None
    hi = None
    if len(node) > 1 and node[1] != "Nothing":
        var = to_se(node[1])
    if len(node) > 2 and node[2] != "Nothing":
        lo = to_se(node[2])
    if len(node) > 3 and node[3] != "Nothing":
        hi = to_se(node[3])
    return (var, lo, hi)

def _apply(head, raw):
    _cache = {}
    def arg(i):
        if i not in _cache:
            _cache[i] = to_se(raw[i])
        return _cache[i]
    def args():
        return [to_se(r) for r in raw]

    # Block: evaluate all, return last
    if head == "Block":
        if not raw:
            return _Integer(0)
        result = _Integer(0)
        for r in raw:
            result = to_se(r)
        return result

    # Function: evaluate body (standalone use)
    if head == "Function":
        if len(raw) >= 1:
            return to_se(raw[0])
        return _Integer(0)

    # Matrix
    if head == "Matrix":
        lists = raw[0][1:] # e.g. ["List", ["List", a], ["List", b]] -> lists = [["List", a], ["List", b]]
        mat = []
        for row in lists:
            # row is a list like ["List", a, b]
            mat.append([to_se(el) for el in row[1:]])
        from symengine import DenseMatrix
        return DenseMatrix(mat)
        
    # Transpose
    if head == "Transpose":
        m = to_se(raw[0])
        return m.T if hasattr(m, 'T') else m.transpose() if hasattr(m, 'transpose') else m

    # Nothing
    if head == "Nothing":
        return _Integer(0)

    # Hold / ReleaseHold
    if head in ("Hold", "ReleaseHold"):
        return arg(0) if raw else _Integer(0)

    # User function call
    if head in _USER_FUNCS:
        params, body = _USER_FUNCS[head]
        vals = args()
        subs_dict = {}
        for i, p in enumerate(params):
            subs_dict[p] = vals[i] if i < len(vals) else _Integer(0)
        return body.subs(subs_dict)

    # Assign / Define
    if head in ("Assign", "Define"):
        fname = raw[0]
        if isinstance(fname, dict):
            fname = fname.get("sym", str(fname))
        elif not isinstance(fname, str):
            fname = str(fname)

        val = raw[1] if len(raw) > 1 else None

        if isinstance(val, list) and len(val) > 0 and val[0] == "Function":
            info = _extract_function(val)
            if info:
                params, body = info
                _USER_FUNCS[fname] = (params, body)
                return ("__ASSIGN__", fname, params, body)

        expr = to_se(val) if val is not None else _Integer(0)
        fs = sorted(expr.free_symbols, key=str)
        if fs:
            var = fs[0]
            _USER_FUNCS[fname] = ([var], expr)
            return ("__ASSIGN__", fname, [var], expr)
        else:
            _USER_VARS[fname] = expr
            return ("__VAR_ASSIGN__", fname, expr)

    # InvisibleOperator (implicit multiplication)
    if head == "InvisibleOperator":
        a_vals = args()
        if not a_vals:
            return _Integer(0)
        for i, r in enumerate(raw):
            if isinstance(r, str) and r in _USER_FUNCS and i + 1 < len(raw):
                params, body = _USER_FUNCS[r]
                call_arg = to_se(raw[i + 1])
                subs_dict = {params[0]: call_arg} if params else {}
                func_result = body.subs(subs_dict)
                others = [to_se(raw[j]) for j in range(len(raw)) if j != i and j != i + 1]
                result = func_result
                for o in others:
                    result = result * o
                return result
        result = a_vals[0]
        for x in a_vals[1:]:
            result = result * x
        return result

    # ── Arithmetic ──────────────────────────────────────────
    if head == "Add":
        a = args()
        r = a[0]
        for x in a[1:]:
            r = r + x
        return r
    if head == "Subtract":
        a = args()
        return -a[0] if len(a) == 1 else a[0] - a[1]
    if head in ("Negate", "Minus"):
        return -arg(0)
    if head == "Multiply":
        # Heuristic: detect user function names mixed in a Multiply
        func_indices = []
        for i, r in enumerate(raw):
            if isinstance(r, str) and r in _USER_FUNCS:
                func_indices.append(i)

        if func_indices:
            remainders = list(range(len(raw)))
            resolved = []
            used = set()
            for fi in func_indices:
                fname_val = raw[fi]
                params, body = _USER_FUNCS[fname_val]
                best_idx = None
                best_dist = float("inf")
                for j in remainders:
                    if j == fi or j in used:
                        continue
                    val = to_se(raw[j])
                    if len(val.free_symbols) == 0:
                        d = abs(j - fi)
                        if d < best_dist:
                            best_dist = d
                            best_idx = j
                if best_idx is not None:
                    call_arg = to_se(raw[best_idx])
                    subs_dict = {params[0]: call_arg} if params else {}
                    resolved.append(body.subs(subs_dict))
                    used.add(fi)
                    used.add(best_idx)
            if resolved:
                result = _Integer(1)
                for r in resolved:
                    result = result * r
                for j in range(len(raw)):
                    if j not in used:
                        result = result * to_se(raw[j])
                return result

        a = []
        is_dot = False
        is_cross = False
        for x in raw:
            if isinstance(x, str) and x == "dot":
                is_dot = True
            elif isinstance(x, str) and x == "cross":
                is_cross = True
            else:
                a.append(to_se(x))

        if is_cross and len(a) == 2 and hasattr(a[0], 'cross'):
            return a[0].cross(a[1])
        if is_dot and len(a) == 2 and hasattr(a[0], 'dot'):
            return a[0].dot(a[1])
            
        r = a[0]
        for x in a[1:]:
            r = r * x
        return r

    if head == "Divide":
        return arg(0) / arg(1)
    if head == "Rational":
        return arg(0) / arg(1) if len(raw) >= 2 else arg(0)
    if head == "Power":
        return arg(0) ** arg(1)
    if head == "Sqrt":
        return sqrt(arg(0))
    if head == "Root":
        return arg(0) ** (_Integer(1) / arg(1))

    # ── Trigonometric ───────────────────────────────────────
    _trig = {"Sin": sin, "Cos": cos, "Tan": tan}
    if asin:
        _trig.update({"Arcsin": asin, "Arccos": acos, "Arctan": atan})
    if head in _trig:
        return _trig[head](arg(0))

    # ── Exponential / Logarithmic ───────────────────────────
    if head == "Exp":
        return exp(arg(0))
    if head in ("Ln", "Log"):
        a = args()
        return log(a[0]) if len(a) == 1 else log(a[0]) / log(a[1])

    # ── Calculus ────────────────────────────────────────────
    if head in ("D", "Derivative"):
        if len(raw) < 2:
            return arg(0) if len(raw) > 0 else _Integer(0)
        
        fn_node = raw[0]
        if isinstance(fn_node, list) and len(fn_node) > 0 and isinstance(fn_node[0], str):
            fname = fn_node[0]
            if fname in _USER_FUNCS:
                f_var, f_body = _USER_FUNCS[fname]
                diff_body = _diff(f_body, f_var)
                call_arg = to_se(fn_node[1]) if len(fn_node) > 1 else _Integer(0)
                return diff_body.subs({f_var: call_arg})
                
        a = args()
        return _diff(a[0], a[1])

    if head == "Integrate":
        arg0 = raw[0] if len(raw) > 0 else None
        arg1 = raw[1] if len(raw) > 1 else None
        expr_val = None
        var = _sym("x")

        if isinstance(arg0, list) and len(arg0) > 0 and arg0[0] == "Function":
            info = _extract_function(arg0)
            if info:
                var, expr_val = info
        else:
            expr_val = to_se(arg0) if arg0 is not None else _Integer(0)

        if isinstance(arg1, list) and len(arg1) > 0:
            if arg1[0] == "Limits":
                lim = _parse_limits(arg1)
                if lim:
                    var = lim[0]
                    lo, hi = lim[1], lim[2]
                    if lo is not None and hi is not None:
                        # Definite integral
                        antideriv = _integrate(expr_val, var)
                        return antideriv.subs({var: hi}) - antideriv.subs({var: lo})
            elif arg1[0] == "Tuple":
                if len(arg1) > 1:
                    var = to_se(arg1[1])
            else:
                var = to_se(arg1)
        elif arg1 is not None and arg1 != "Nothing":
            var = to_se(arg1)

        return _integrate(expr_val, var)

    # ── Sum ─────────────────────────────────────────────────
    if head == "Sum":
        if len(raw) == 0:
            return _Integer(0)
        body_node = raw[0]
        body_expr = None
        loop_var = _sym("i")
        lo = None
        hi = None

        # Parse body: may be Function node wrapping the actual body
        if isinstance(body_node, list) and len(body_node) > 0 and body_node[0] == "Function":
            info = _extract_function(body_node)
            if info:
                loop_var, body_expr = info
        if body_expr is None:
            body_expr = to_se(body_node)

        # Parse limits
        if len(raw) > 1:
            lim_node = raw[1]
            if isinstance(lim_node, list) and len(lim_node) > 0 and lim_node[0] == "Limits":
                lim = _parse_limits(lim_node)
                if lim:
                    loop_var, lo, hi = lim
            elif isinstance(lim_node, list) and len(lim_node) > 0 and lim_node[0] == "Tuple":
                if len(lim_node) == 3:
                    lo = to_se(lim_node[1])
                    hi = to_se(lim_node[2])
                elif len(lim_node) >= 4:
                    loop_var = to_se(lim_node[1])
                    lo = to_se(lim_node[2])
                    hi = to_se(lim_node[3])

        # Also check raw[2] for limits not in a Limits node
        if lo is None and len(raw) > 2:
            lo = to_se(raw[2])
        if hi is None and len(raw) > 3:
            hi = to_se(raw[3])

        # If we have concrete integer bounds, compute the sum
        if lo is not None and hi is not None:
            try:
                return _finite_sum(body_expr, loop_var, lo, hi)
            except Exception:
                pass

        # If body has no free var matching loop_var, it's constant * (hi-lo+1)
        if loop_var not in body_expr.free_symbols:
            if lo is not None and hi is not None:
                return body_expr * (hi - lo + _Integer(1))

        # Symbolic: return unevaluated string description
        return body_expr

    # ── Product ─────────────────────────────────────────────
    if head == "Product":
        if len(raw) == 0:
            return _Integer(1)
        body_node = raw[0]
        body_expr = None
        loop_var = _sym("i")
        lo = None
        hi = None

        if isinstance(body_node, list) and len(body_node) > 0 and body_node[0] == "Function":
            info = _extract_function(body_node)
            if info:
                loop_var, body_expr = info
        if body_expr is None:
            body_expr = to_se(body_node)

        if len(raw) > 1:
            lim_node = raw[1]
            if isinstance(lim_node, list) and len(lim_node) > 0 and lim_node[0] == "Limits":
                lim = _parse_limits(lim_node)
                if lim:
                    loop_var, lo, hi = lim
            elif isinstance(lim_node, list) and len(lim_node) > 0 and lim_node[0] == "Tuple":
                if len(lim_node) == 3:
                    lo = to_se(lim_node[1])
                    hi = to_se(lim_node[2])
                elif len(lim_node) >= 4:
                    loop_var = to_se(lim_node[1])
                    lo = to_se(lim_node[2])
                    hi = to_se(lim_node[3])

        if lo is None and len(raw) > 2:
            lo = to_se(raw[2])
        if hi is None and len(raw) > 3:
            hi = to_se(raw[3])

        if lo is not None and hi is not None:
            try:
                return _finite_product(body_expr, loop_var, lo, hi)
            except Exception:
                pass

        if loop_var not in body_expr.free_symbols:
            if lo is not None and hi is not None:
                n = hi - lo + _Integer(1)
                return body_expr ** n

        return body_expr

    # ── At (evaluate expression at point, for d/dx ... |_{x=2}) ──
    if head == "At":
        # ["At", expr_node, conditions_node]
        expr_val = arg(0) if len(raw) > 0 else _Integer(0)
        if len(raw) > 1:
            cond = raw[1]
            # cond could be ["Equal", var, val] or ["Pair", var, val]
            if isinstance(cond, list) and len(cond) >= 3:
                chead = cond[0]
                if chead in ("Equal", "Eq", "Pair"):
                    sub_var = to_se(cond[1])
                    sub_val = to_se(cond[2])
                    return expr_val.subs({sub_var: sub_val})
            # cond could also be a dict like {var: val}
            if isinstance(cond, dict):
                subs = {}
                for k, v in cond.items():
                    subs[_sym(k)] = to_se(v)
                return expr_val.subs(subs)
        return expr_val

    # ── Equality ────────────────────────────────────────────
    if head in ("Equal", "Eq"):
        a = args()
        if len(a) == 2:
            return a[0] - a[1]
        return a[0]

    # ── Abs ─────────────────────────────────────────────────
    if head == "Abs":
        try:
            return _se.Abs(arg(0))
        except Exception:
            return arg(0)

    # ── Factorial ──────────────────────────────────────────
    if head == "Factorial":
        try:
            from symengine import gamma
            return gamma(arg(0) + 1)
        except Exception:
            return arg(0)

    # ── Delimiter / grouping ───────────────────────────────
    if head == "Delimiter":
        if raw:
            return to_se(raw[0])
        return _Integer(0)

    # ── Sequences ──────────────────────────────────────────
    if head in ("Pair", "Tuple", "Triple", "List", "Sequence",
                "Range", "Interval"):
        avals = args()
        # Handle implicit matrix multiplication or explicit dot/cross in Tuple
        if head == "Tuple":
            if len(raw) == 3 and isinstance(raw[1], str) and raw[1] == "cross":
                A = avals[0]
                B = avals[2]
                if hasattr(A, 'cross'): return A.cross(B)
                return _mul_factors([A, B])
            if len(raw) == 3 and isinstance(raw[1], str) and raw[1] == "dot":
                A = avals[0]
                B = avals[2]
                if hasattr(A, 'dot'): return A.dot(B)
                return _mul_factors([A, B])
                
            # If all elements are matrices (or some are numbers/symbols?), we just multiply them? 
            # Let's check if all avals are matrices or sym/numbers. Actually, if Cortex couldn't parse it and returned Tuple, 
            # and it has no strings, it's likely implicit multiplication.
            from symengine import DenseMatrix, Expr, Symbol, Integer, Float
            is_mult = True
            for x in raw:
                if isinstance(x, str) and x in ("dot", "cross"):
                    is_mult = False
            if is_mult and len(avals) >= 2:
                # check if there's at least one Matrix
                has_mat = any(hasattr(v, 'shape') for v in avals)
                if has_mat:
                    res = avals[0]
                    for i in range(1, len(avals)):
                        res = res * avals[i]
                    return res

        return avals

    # ── Subscript – treat x_i as a single symbol ───────────
    if head == "Subscript":
        if len(raw) >= 2 and isinstance(raw[0], list) and len(raw[0]) > 0 and raw[0][0] == "EvaluateAt":
            fn_node = raw[0][1] if len(raw[0]) > 1 else None
            cond = raw[1]
            real_expr = fn_node
            if isinstance(fn_node, list) and len(fn_node) > 0 and fn_node[0] == "Function":
                real_expr = fn_node[1]
            return _apply("At", [real_expr, cond])

        base = raw[0] if raw else "x"
        sub = raw[1] if len(raw) > 1 else "0"
        base_s = base if isinstance(base, str) else str(base)
        sub_s = sub if isinstance(sub, str) else str(sub)
        name = base_s + "_" + sub_s
        if name in _USER_VARS:
            return _USER_VARS[name]
        return _sym(name)

    # ── Fallback ───────────────────────────────────────────
    a = args()
    try:
        s = head + "(" + ", ".join(str(x) for x in a) + ")"
        # Guard: only call sympify if string looks safe (no quotes, brackets etc.)
        import re as _re_mod
        if _re_mod.match(r"^[A-Za-z0-9_+\\-*/().^, ]+$", s):
            return _se.sympify(s)
        return a[0] if a else _Integer(0)
    except Exception:
        return a[0] if a else _Integer(0)


# ── LaTeX renderer (tree-walking) ────────────────────────────
def to_latex(expr):
    if isinstance(expr, str):
        return expr
    if isinstance(expr, (list, tuple)):
        return ", ".join(to_latex(e) for e in expr)
    try:
        return _to_latex(expr)
    except Exception:
        # Catch-all: try to return something sensible
        s = str(expr)
        # If it looks like Rational(a,b), convert to frac
        import re
        m = re.match(r"Rational\\((-?\\d+),\\s*(\\d+)\\)", s)
        if m:
            p, q = m.group(1), m.group(2)
            sign = "-" if p.startswith("-") else ""
            p = p.lstrip("-")
            return sign + _BS + "frac{" + p + "}{" + q + "}"
        return s

def _to_latex(expr):
    BS = chr(92)
    
    # DenseMatrix
    if type(expr).__name__ == "MutableDenseMatrix" or type(expr).__name__ == "ImmutableDenseMatrix" or "Matrix" in type(expr).__name__:
        rows = expr.shape[0]
        cols = expr.shape[1]
        out = BS + "begin{bmatrix} "
        for r in range(rows):
            row_vals = []
            for c in range(cols):
                row_vals.append(to_latex(expr[r, c]))
            out += " & ".join(row_vals)
            if r < rows - 1:
                out += " " + BS + BS + " "
        out += " " + BS + "end{bmatrix}"
        
        # If it's a 1x1 matrix, some users might prefer it as scalar, but it's fundamentally a matrix.
        # But wait, 1x3 times 3x1 mathematically IS a 1x1 matrix. Let's return the scalar if user asks.
        if rows == 1 and cols == 1:
            # Let's extract the single element so it behaves as a number visually if derived from dot product
            # Actually, standard matrix multiplication yields a 1x1 matrix. Symengine does too. 
            pass
        return out

    # Constants
    if expr is pi or (isinstance(expr, _Symbol) and str(expr) == "pi"):
        return BS + "pi"
    if expr is oo:
        return BS + "infty"
    if expr is -oo:
        return "-" + BS + "infty"
    if expr is E:
        return "e"
    if expr is I:
        return "i"

    # Integer
    if isinstance(expr, _Integer):
        return str(int(expr))

    # Rational (not Integer) – robust check
    if hasattr(expr, 'p') and hasattr(expr, 'q'):
        try:
            p, q = int(expr.p), int(expr.q)
            if q != 1:
                sign = "-" if p < 0 else ""
                return sign + BS + "frac{" + str(abs(p)) + "}{" + str(q) + "}"
            return str(p)
        except Exception:
            pass

    if isinstance(expr, _Rational):
        p, q = int(expr.p), int(expr.q)
        if q == 1:
            return str(p)
        sign = "-" if p < 0 else ""
        return sign + BS + "frac{" + str(abs(p)) + "}{" + str(q) + "}"

    # Float
    if isinstance(expr, _Float):
        v = float(expr)
        if v == int(v) and abs(v) < 1e15:
            return str(int(v))
        return f"{v:.10g}"

    # Symbol
    if isinstance(expr, _Symbol):
        name = str(expr)
        greek = {
            "alpha": BS+"alpha", "beta": BS+"beta", "gamma": BS+"gamma",
            "delta": BS+"delta", "epsilon": BS+"epsilon", "theta": BS+"theta",
            "lambda": BS+"lambda", "mu": BS+"mu", "sigma": BS+"sigma",
            "phi": BS+"phi", "omega": BS+"omega", "pi": BS+"pi",
        }
        # Handle subscripted symbols like x_i
        if "_" in name and not name.startswith("_"):
            parts = name.split("_", 1)
            base = greek.get(parts[0], parts[0])
            sub = greek.get(parts[1], parts[1])
            return base + "_{" + sub + "}"
        return greek.get(name, name)

    # Add
    if isinstance(expr, _Add):
        terms = list(expr.args)
        parts = []
        for i, t in enumerate(terms):
            t_ltx = _to_latex(t)
            if i == 0:
                parts.append(t_ltx)
            elif t_ltx.startswith("-"):
                parts.append(" - " + t_ltx[1:])
            else:
                parts.append(" + " + t_ltx)
        return "".join(parts)

    # Mul
    if isinstance(expr, _Mul):
        args_list = list(expr.args)
        sign = ""
        numer = []
        denom = []

        for a in args_list:
            if isinstance(a, _Integer) and int(a) == -1:
                sign = "-" if sign == "" else ""
                continue
            if isinstance(a, _Integer) and int(a) < 0:
                sign = "-" if sign == "" else ""
                numer.append(_Integer(-int(a)))
                continue
            # Rational factor (e.g. 5/2)
            if hasattr(a, 'p') and hasattr(a, 'q') and not isinstance(a, _Integer):
                try:
                    p, q = int(a.p), int(a.q)
                    if q != 1:
                        if p < 0:
                            sign = "-" if sign == "" else ""
                            p = -p
                        if p != 1:
                            numer.append(_Integer(p))
                        denom.append(_Integer(q))
                        continue
                except Exception:
                    pass
            if isinstance(a, _Rational) and not isinstance(a, _Integer):
                p, q = int(a.p), int(a.q)
                if p < 0:
                    sign = "-" if sign == "" else ""
                    p = -p
                if p != 1:
                    numer.append(_Integer(p))
                denom.append(_Integer(q))
                continue
            if isinstance(a, _Pow):
                base_a, exp_a = a.args
                if isinstance(exp_a, _Integer) and int(exp_a) < 0:
                    if int(exp_a) == -1:
                        denom.append(base_a)
                    else:
                        denom.append(base_a ** (-exp_a))
                    continue
                if isinstance(exp_a, _Rational) and not isinstance(exp_a, _Integer):
                    if float(exp_a) < 0:
                        denom.append(base_a ** (-exp_a))
                        continue
            numer.append(a)

        n_str = _mul_factors(numer) if numer else "1"
        if denom:
            d_str = _mul_factors(denom) if denom else "1"
            return sign + BS + "frac{" + n_str + "}{" + d_str + "}"
        return sign + n_str

    # Pow
    if isinstance(expr, _Pow):
        base, ex = expr.args
        if ex == _Rational(1, 2):
            return BS + "sqrt{" + _to_latex(base) + "}"
        if ex == _Integer(-1):
            return BS + "frac{1}{" + _to_latex(base) + "}"
        if isinstance(ex, _Integer) and int(ex) < 0:
            return BS + "frac{1}{" + _to_latex(base) + "^{" + str(-int(ex)) + "}}"
        if base is E or (isinstance(base, _Symbol) and str(base) == "E"):
            return "e^{" + _to_latex(ex) + "}"
        base_ltx = _to_latex(base)
        if isinstance(base, (_Add, _Mul)):
            base_ltx = BS + "left(" + base_ltx + BS + "right)"
        return base_ltx + "^{" + _to_latex(ex) + "}"

    # Trig / functions
    if isinstance(expr, sin):
        return BS + "sin" + BS + "left(" + _to_latex(expr.args[0]) + BS + "right)"
    if isinstance(expr, cos):
        return BS + "cos" + BS + "left(" + _to_latex(expr.args[0]) + BS + "right)"
    if isinstance(expr, tan):
        return BS + "tan" + BS + "left(" + _to_latex(expr.args[0]) + BS + "right)"

    # Log
    type_name = type(expr).__name__
    if type_name == "log":
        return BS + "ln" + BS + "left(" + _to_latex(expr.args[0]) + BS + "right)"

    # Fallback: use str() but try to clean up
    s = str(expr)
    import re
    m = re.match(r"Rational\\((-?\\d+),\\s*(\\d+)\\)", s)
    if m:
        p, q = m.group(1), m.group(2)
        sign_s = "-" if p.startswith("-") else ""
        p = p.lstrip("-")
        return sign_s + BS + "frac{" + p + "}{" + q + "}"
    return s


def _mul_factors(factors):
    """Render a list of multiplicative factors as LaTeX."""
    if not factors:
        return "1"
    BS = chr(92)
    parts = []
    for f in factors:
        ltx = _to_latex(f)
        if isinstance(f, _Add):
            ltx = BS + "left(" + ltx + BS + "right)"
        parts.append(ltx)
    result = parts[0]
    for i in range(1, len(parts)):
        prev_end = result[-1] if result else ""
        curr_start = parts[i][0] if parts[i] else ""
        if prev_end.isdigit() and (curr_start.isalpha() or curr_start == BS):
            result += " " + parts[i]
        elif prev_end == "}" and (curr_start.isalpha() or curr_start == BS):
            result += " " + parts[i]
        else:
            result += " " + BS + "cdot " + parts[i]
    return result


def _try_numeric(expr):
    """Try to convert an expression to a float string."""
    try:
        v = float(expr)
        return f"{v:.10g}"
    except Exception:
        # Try expanding first
        try:
            v = float(_expand(expr))
            return f"{v:.10g}"
        except Exception:
            return None


# ── Public entry points ──────────────────────────────────────
def evaluate(json_str, operation="simplify"):
    try:
        node = json.loads(json_str) if isinstance(json_str, str) else json_str

        # Guard against double-encoding
        if isinstance(node, str):
            try:
                node2 = json.loads(node)
                if not isinstance(node2, str):
                    node = node2
            except Exception:
                pass

        expr = to_se(node)

         # Handle Assign result (returns a tuple marker)
        if isinstance(expr, tuple) and expr and isinstance(expr[0], str) and expr[0].startswith("__"):
            expr = [expr]
            
        if isinstance(expr, list) and len(expr) > 0 and isinstance(expr[0], tuple) and expr[0] and isinstance(expr[0][0], str) and expr[0][0].startswith("__"):
            BS = chr(92)
            out_ltx = []
            out_txt = []
            for e in expr:
                if e[0] == "__ASSIGN__":
                    _, fname, params, body = e
                    plst = ",".join(to_latex(p) for p in params)
                    plst_str = ",".join(str(p) for p in params)
                    ltx = (fname + BS + "left(" + plst +
                           BS + "right) " + BS + "coloneq " + to_latex(body))
                    out_ltx.append(ltx)
                    out_txt.append(f"{fname}({plst_str}) := {body}")
                elif e[0] == "__VAR_ASSIGN__":
                    _, vname, val = e
                    vstr = vname if isinstance(vname, str) else vname.get("sym", str(vname)) if isinstance(vname, dict) else str(vname)
                    if vstr.startswith(BS + "mathrm{") and vstr.endswith("}"):
                        ltx_vname = vstr
                    elif len(vstr) > 1:
                        ltx_vname = BS + "mathrm{" + vstr + "}"
                    else:
                        ltx_vname = vstr
                    ltx = ltx_vname + " " + BS + "coloneq " + to_latex(val)
                    out_ltx.append(ltx)
                    out_txt.append(f"{vstr} := {val}")
            return json.dumps({
                "success": True,
                "latex": ("," + BS + " ").join(out_ltx),
                "text": ", ".join(out_txt),
                "defined_variable": "multiple"
            })

        # Regular expression evaluation
        # Guard: DenseMatrix should not go through _expand/_diff etc.
        from symengine import DenseMatrix as _DM
        _is_matrix = isinstance(expr, _DM)

        if _is_matrix:
            result = expr
            # Auto-unpack 1x1 matrices to scalars for frontend display
            if hasattr(result, 'shape') and result.shape == (1, 1):
                result = result[0, 0]
        elif operation == "expand":
            result = _expand(expr)
        elif operation in ("simplify", "evaluate"):
            result = _expand(expr)
        elif operation == "diff":
            fs = sorted(expr.free_symbols, key=str)
            var = fs[0] if fs else _Symbol("x")
            result = _diff(expr, var)
        elif operation == "integrate":
            fs = sorted(expr.free_symbols, key=str)
            var = fs[0] if fs else _Symbol("x")
            result = _integrate(expr, var)
        elif operation == "factor":
            result = _expand(expr)
        elif operation == "solve":
            fs = sorted(expr.free_symbols, key=str)
            var = fs[0] if fs else _Symbol("x")
            result = _solve(expr, var)
        elif operation == "numeric":
            v = _try_numeric(expr)
            if v is not None:
                return json.dumps({
                    "success": True,
                    "latex": v,
                    "text": v,
                })
            # Fall back to symbolic
            result = _expand(expr)
        else:
            result = _expand(expr)

        # Format result
        if isinstance(result, (list, tuple, set)):
            items = list(result)
            ltx = ", ".join(to_latex(r) for r in items)
            txt = ", ".join(str(r) for r in items)
        else:
            ltx = to_latex(result)
            txt = str(result)

        return json.dumps({
            "success": True,
            "latex": ltx,
            "text": txt,
        })
    except Exception as exc:
        return json.dumps({
            "success": False,
            "error": str(exc),
            "traceback": traceback.format_exc(),
        })


def evaluate_string(expr_str, operation="simplify"):
    try:
        expr = _se.sympify(expr_str)
        if operation == "expand":
            result = _expand(expr)
        elif operation == "diff":
            fs = sorted(expr.free_symbols, key=str)
            var = fs[0] if fs else _Symbol("x")
            result = _diff(expr, var)
        elif operation == "integrate":
            fs = sorted(expr.free_symbols, key=str)
            var = fs[0] if fs else _Symbol("x")
            result = _integrate(expr, var)
        elif operation == "numeric":
            v = _try_numeric(expr)
            if v is not None:
                return json.dumps({
                    "success": True,
                    "latex": v,
                    "text": v,
                })
            result = _expand(expr)
        else:
            result = _expand(expr)
        return json.dumps({
            "success": True,
            "latex": to_latex(result),
            "text": str(result),
        })
    except Exception as exc:
        return json.dumps({
            "success": False,
            "error": str(exc),
        })

`;

  // ----------------------------------------------------------
  // 3.  PYODIDE MANAGER
  // ----------------------------------------------------------

  const Pyodide = {
    /** The Pyodide runtime object (set after init). */
    runtime: null,
    /** True once the bridge Python code has been executed. */
    bridgeReady: false,

    /**
     * Boot Pyodide, install SymEngine wheel, and run the bridge.
     * Updates #pyodide-status along the way.
     */
    async init() {
      const status = document.getElementById("pyodide-status");
      try {
        // Step 1 – Load Pyodide itself
        _setStatus(status, "Loading Pyodide…");
        this.runtime = await loadPyodide({
          indexURL: CFG.PYODIDE_INDEX,
        });

        // Step 2 – Install SymEngine via micropip
        _setStatus(status, "Installing SymEngine…");
        await this.runtime.loadPackage("micropip");
        await this.runtime.runPythonAsync(`
import micropip
await micropip.install("${CFG.SYMENGINE_WHEEL}")
`);

        // Step 3 – Execute the MathJSON → SymEngine bridge
        _setStatus(status, "Setting up bridge…");
        await this.runtime.runPythonAsync(PYTHON_BRIDGE);

        this.bridgeReady = true;
        _setStatus(status, "CAS Ready", "ready");
        console.log("[MapleCAS] Pyodide + SymEngine bridge initialised ✓");
      } catch (err) {
        console.error("[MapleCAS] Pyodide init error:", err);
        _setStatus(status, "Engine failed – " + err.message, "error");
      }
    },

    /**
     * Call the Python `evaluate()` function with a MathJSON string.
     * @param {string} mathJsonStr  – JSON-encoded MathJSON
     * @param {string} operation    – "simplify"|"expand"|"diff"|"integrate"|"factor"|"solve"
     * @returns {object} parsed JSON result  { success, latex, text, … }
     */
    async evaluate(mathJsonStr, operation = "simplify") {
      if (!this.bridgeReady) {
        return { success: false, error: "CAS engine is still loading." };
      }
      try {
        // Pass data via Pyodide globals to avoid string-escaping issues
        this.runtime.globals.set("_mj_input", mathJsonStr);
        this.runtime.globals.set("_mj_op", operation);
        const resultStr = await this.runtime.runPythonAsync(
          "evaluate(_mj_input, _mj_op)"
        );
        return JSON.parse(resultStr);
      } catch (err) {
        return { success: false, error: err.message };
      }
    },

    /**
     * Fallback: evaluate a plain expression string  (e.g. "x**2+1").
     */
    async evaluateString(exprStr, operation = "simplify") {
      if (!this.bridgeReady) {
        return { success: false, error: "CAS engine is still loading." };
      }
      try {
        this.runtime.globals.set("_str_input", exprStr);
        this.runtime.globals.set("_str_op", operation);
        const resultStr = await this.runtime.runPythonAsync(
          "evaluate_string(_str_input, _str_op)"
        );
        return JSON.parse(resultStr);
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  };

  /** Helper: update the status badge. */
  function _setStatus(el, text, cls) {
    if (!el) return;
    el.className = cls || "";
    el.innerHTML = `<span class="dot"></span> ${text}`;
  }

  // ----------------------------------------------------------
  // 4.  CELL MANAGER
  // ----------------------------------------------------------
  // Each "cell" has:
  //   • An editable <math-field> for input
  //   • A read-only output area (shown after evaluation)
  //   • A spinner shown during evaluation
  // ----------------------------------------------------------

  const Cells = {
    /** Ordered list of cell ids. */
    ids: [],
    /** Currently focused cell id. */
    activeCellId: null,
    /** Counter used to generate unique ids. */
    _counter: 0,

    /**
     * Create a new math cell and append it to #document.
     * @param {string} [initialLatex]  Optional starting LaTeX content.
     * @returns {string} The new cell's id.
     */
    create(initialLatex = "", insertAfterId = null) {
      const id = "cell-" + this._counter++;
      if (insertAfterId) {
        const idx = this.ids.indexOf(insertAfterId);
        if (idx !== -1) {
          this.ids.splice(idx + 1, 0, id);
        } else {
          this.ids.push(id);
        }
      } else {
        this.ids.push(id);
      }

      // ── DOM Structure ────────────────────────────────────
      const cell = document.createElement("div");
      cell.className = "math-cell";
      cell.id = id;
      cell.dataset.type = "math";
      cell.innerHTML = `
        <div class="cell-row">
          <div class="cell-prompt">▸</div>
          <div class="cell-input">
            <math-field id="${id}-input"></math-field>
          </div>
          <button class="cell-delete-btn" id="${id}-delete" title="Delete cell">✕</button>
        </div>
        <div class="cell-spinner" id="${id}-spinner">
          <div class="spin-ring"></div>
          <span>Evaluating…</span>
        </div>
        <div class="cell-output" id="${id}-output">
          <div class="output-label"></div>
          <math-field id="${id}-result" read-only></math-field>
          <div class="error-msg" id="${id}-error"></div>
        </div>
        <div class="cell-insert-bar">
          <button class="btn-insert-bar" onclick="window.MapleCASInsert('${id}', 'math')">+ Math</button>
          <button class="btn-insert-bar" onclick="window.MapleCASInsert('${id}', 'text')">+ Text</button>
        </div>
      `;
      if (insertAfterId) {
        const target = document.getElementById(insertAfterId);
        if (target) {
          target.insertAdjacentElement("afterend", cell);
        } else {
          document.getElementById("document").appendChild(cell);
        }
      } else {
        document.getElementById("document").appendChild(cell);
      }

      // ── Get the <math-field> element ─────────────────────
      const mf = document.getElementById(`${id}-input`);

      // ── Configure MathLive ──────────────────────────────
      _configureMathField(mf);

      // Set initial content (if any)
      if (initialLatex) {
        requestAnimationFrame(() => {
          mf.value = initialLatex;
        });
      }

      // ── Focus handling ───────────────────────────────────
      mf.addEventListener("focusin", () => {
        this._setActive(id);
      });

      // ── Evaluate on Enter (physical KB) ─────────────────
      // Use a flag so autocomplete completion doesn't trigger eval
      let _lastInputTime = 0;
      let _lastEvalTime = 0;
      mf.addEventListener("input", (ev) => {
        _lastInputTime = Date.now();
        if (ev.inputType === "insertLineBreak") {
          this.evaluateCell(id);
        }
        ContextPanel.update(id);
        _debounceSaveState();
      });

      mf.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && !ev.shiftKey) {
          // If an input event just fired, or MathLive already consumed it
          if (ev.defaultPrevented) return;
          // Defer to see if MathLive consumes it for auto-complete
          setTimeout(() => {
            if (Date.now() - _lastInputTime < 50) return; // just autocompleted
            _lastEvalTime = Date.now();
            this.evaluateCell(id);
          }, 50);
        } else if (ev.key === "Tab") {
          // Allow tab to autocomplete
          if (!ev.shiftKey) {
            mf.executeCommand("complete");
          }
        }
      });

      // ── Click on result → toggle numeric/symbolic ───────
      const resultMf = document.getElementById(`${id}-result`);
      if (resultMf) {
        resultMf.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this._toggleResultMode(id);
        });
        resultMf.style.cursor = "pointer";
      }

      // ── Delete button ────────────────────────────────────
      const delBtn = document.getElementById(`${id}-delete`);
      if (delBtn) {
        delBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.deleteCell(id);
        });
      }

      // Focus the new cell
      requestAnimationFrame(() => mf.focus());
      this._setActive(id);

      return id;
    },

    /**
     * Create a text-only cell (no math evaluation).
     * @param {string} [initialText]
     * @returns {string} The new cell's id.
     */
    createText(initialText = "", insertAfterId = null) {
      const id = "cell-" + this._counter++;
      if (insertAfterId) {
        const idx = this.ids.indexOf(insertAfterId);
        if (idx !== -1) {
          this.ids.splice(idx + 1, 0, id);
        } else {
          this.ids.push(id);
        }
      } else {
        this.ids.push(id);
      }

      const cell = document.createElement("div");
      cell.className = "math-cell text-cell";
      cell.id = id;
      cell.dataset.type = "text";
      cell.innerHTML = `
        <div class="cell-row">
          <div class="cell-prompt">¶</div>
          <div class="cell-input">
            <div class="text-cell-editor" id="${id}-input"
                 contenteditable="true" spellcheck="true"
                 data-placeholder="Type text here…"></div>
          </div>
          <button class="cell-delete-btn" id="${id}-delete" title="Delete cell">✕</button>
        </div>
        <div class="cell-insert-bar">
          <button class="btn-insert-bar" onclick="window.MapleCASInsert('${id}', 'math')">+ Math</button>
          <button class="btn-insert-bar" onclick="window.MapleCASInsert('${id}', 'text')">+ Text</button>
        </div>
      `;
      if (insertAfterId) {
        const target = document.getElementById(insertAfterId);
        if (target) {
          target.insertAdjacentElement("afterend", cell);
        } else {
          document.getElementById("document").appendChild(cell);
        }
      } else {
        document.getElementById("document").appendChild(cell);
      }

      const editor = document.getElementById(`${id}-input`);
      if (initialText) editor.textContent = initialText;

      editor.addEventListener("focusin", () => this._setActive(id));
      editor.addEventListener("input", () => _debounceSaveState());
      editor.addEventListener("keydown", (ev) => {
        // Enter in text cell creates new math cell below
        if (ev.key === "Enter" && !ev.shiftKey) {
          ev.preventDefault();
          const newId = this.create("", id);
          const mf = document.getElementById(`${newId}-input`);
          if (mf) mf.focus();
        }
      });

      const delBtn = document.getElementById(`${id}-delete`);
      if (delBtn) {
        delBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.deleteCell(id);
        });
      }

      requestAnimationFrame(() => editor.focus());
      this._setActive(id);
      return id;
    },

    /** Mark a cell as active and update UI. */
    _setActive(id) {
      // Remove old focus ring
      if (this.activeCellId) {
        const old = document.getElementById(this.activeCellId);
        if (old) old.classList.remove("focused");
      }
      this.activeCellId = id;
      const el = document.getElementById(id);
      if (el) el.classList.add("focused");
      ContextPanel.update(id);
    },

    /**
     * Delete a cell by its id.
     */
    deleteCell(cellId) {
      const idx = this.ids.indexOf(cellId);
      if (idx === -1) return;
      if (this.ids.length <= 1) return;
      const el = document.getElementById(cellId);
      if (el) el.remove();
      this.ids.splice(idx, 1);
      if (this.activeCellId === cellId) {
        const nextIdx = Math.min(idx, this.ids.length - 1);
        const nextId = this.ids[nextIdx];
        const nextMf = document.getElementById(`${nextId}-input`);
        if (nextMf) nextMf.focus();
        this._setActive(nextId);
      }
      _debounceSaveState();
    },

    /**
     * Toggle a result between symbolic and numeric display.
     */
    async _toggleResultMode(cellId) {
      const output = document.getElementById(`${cellId}-output`);
      const resultMf = document.getElementById(`${cellId}-result`);
      if (!output || !output.classList.contains("visible")) return;

      const current = output.dataset.mode || "symbolic";
      if (current === "symbolic") {
        // Switch to numeric
        const mj = output.dataset.mathJson;
        if (mj) {
          const numResult = await Pyodide.evaluate(mj, "numeric");
          if (numResult && numResult.success) {
            resultMf.value = numResult.latex || numResult.text || "";
            output.dataset.numericLatex = numResult.latex || numResult.text || "";
            output.dataset.mode = "numeric";
            output.querySelector(".output-label").textContent = "≈ numeric";
          }
        }
      } else {
        // Switch back to symbolic
        resultMf.value = output.dataset.symbolicLatex || "";
        output.dataset.mode = "symbolic";
        output.querySelector(".output-label").textContent = output.dataset.operation || "simplify";
      }
    },

    /**
     * Get the active <math-field> element.
     * @returns {HTMLElement|null}
     */
    getActiveMathField() {
      if (!this.activeCellId) return null;
      return document.getElementById(`${this.activeCellId}-input`);
    },

    /**
     * Run the evaluation pipeline for a cell.
     * @param {string} cellId
     * @param {string} operation  – CAS operation name
     */
    async evaluateCell(cellId, operation = null) {
      // Skip text cells
      const cellEl = document.getElementById(cellId);
      if (cellEl?.dataset.type === "text") return;

      if (!operation) {
        operation = "simplify";
      }
      const mf = document.getElementById(`${cellId}-input`);
      const spinner = document.getElementById(`${cellId}-spinner`);
      const output = document.getElementById(`${cellId}-output`);
      const resultMf = document.getElementById(`${cellId}-result`);
      const errorDiv = document.getElementById(`${cellId}-error`);

      if (!mf) return;

      // Get the LaTeX & MathJSON from MathLive
      let latex = mf.getValue("latex") || "";
      if (!latex.trim()) return; // nothing to evaluate

      let patchedLatex = false;
      let origLatex = latex;

      // 1. replace cross and dot products
      latex = latex.replace(/\\times/g, "\\operatorname{cross}");
      latex = latex.replace(/\\cdot/g, "\\operatorname{dot}");
      
      // 2. Multichar variables wrapped in mathrm
      let cmds = [];
      latex = latex.replace(/\\[a-zA-Z]+(?:\{[^}]*\})?/g, m => { cmds.push(m); return `\uE000${cmds.length-1}\uE001`; });
      latex = latex.replace(/(?<![a-zA-Z])([a-zA-Z]{2,})(?![a-zA-Z])/g, "\\mathrm{$1}");
      latex = latex.replace(/\uE000(\d+)\uE001/g, (m, i) => cmds[i]);

      if (origLatex !== latex) patchedLatex = true;

      // Fix \colon= visual bug -> we update the math field visually
      if (latex.includes("\\colon=")) {
        latex = latex.replace(/\\colon=/g, "\\coloneq");
        mf.setValue(latex, { selectionMode: "after" });
      }

      // Fix \bigm| which CortexJS cannot parse without \left.
      if (latex.includes("\\bigm|")) {
        latex = "\\left. " + latex.replace(/\\bigm\|/g, "\\right|");
        patchedLatex = true;
      }

      // Fix \sum_0^5 without a loop variable
      if (latex.includes("\\sum_") || latex.includes("\\prod_")) {
        let oldLatex = latex;
        latex = latex.replace(/\\(sum|prod)_\{([^=}]+)\}/g, "\\$1_{i=$2}");
        latex = latex.replace(/\\(sum|prod)_([^{}=a-zA-Z_]\w*|\d+)/g, "\\$1_{i=$2}");
        if (oldLatex !== latex) patchedLatex = true;
      }

      let mathJson;
      try {
        let raw;
        if (patchedLatex && window.MathfieldElement && window.MathfieldElement.computeEngine) {
          try {
            raw = window.MathfieldElement.computeEngine.parse(latex)?.json;
          } catch (_) {}
        }

        // Primary: use .expression.json to get plain MathJSON value
        if (raw === undefined || raw === null) {
          try {
            if (mf.expression && typeof mf.expression.json !== "undefined") {
              raw = mf.expression.json;
            }
          } catch (_) {}
        }
        // Fallback: getValue
        if (raw === undefined || raw === null) {
          raw = mf.getValue("math-json");
        }
        // Handle BoxedExpression objects
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          if (typeof raw.json !== "undefined") raw = raw.json;
          else if (typeof raw.toJSON === "function") raw = raw.toJSON();
        }
        // Guard against double-encoded strings
        if (typeof raw === "string") {
          try {
            const parsed = JSON.parse(raw);
            if (typeof parsed !== "string") raw = parsed;
          } catch (_) {}
        }
        mathJson = JSON.stringify(raw);
        console.log("[MapleCAS] MathJSON:", mathJson);
      } catch (e) {
        console.warn("[MapleCAS] MathJSON extraction error:", e);
        mathJson = null;
      }

      // Show spinner, hide previous output
      spinner.classList.add("visible");
      output.classList.remove("visible");
      errorDiv.textContent = "";

      let result;
      if (mathJson) {
        // Primary path: MathJSON → Python bridge
        result = await Pyodide.evaluate(mathJson, operation);
      }

      // Fallback: try plain-string path if MathJSON failed
      // But skip fallback for matrix expressions – sympify can't parse them
      const hasMatrix = /\\begin\{[bBpvV]?matrix\}|bmatrix|pmatrix/.test(latex);
      if ((!result || !result.success) && !hasMatrix) {
        // Build a basic expression string from LaTeX
        const exprStr = _latexToExprString(latex);
        if (exprStr) {
          const fallback = await Pyodide.evaluateString(exprStr, operation);
          if (fallback.success) result = fallback;
          else if (!result) result = fallback;
        }
      }

      // Hide spinner
      spinner.classList.remove("visible");

      if (!result) {
        result = { success: false, error: "No result returned." };
      }

      // Display result
      if (result.success) {
        output.querySelector(".output-label").textContent = operation;
        resultMf.value = result.latex || result.text || "";
        errorDiv.textContent = "";
        output.classList.add("visible");

        // Store both symbolic and numeric data for toggle
        output.dataset.symbolicLatex = result.latex || result.text || "";
        output.dataset.symbolicText  = result.text || "";
        output.dataset.mode = "symbolic";
        output.dataset.mathJson = mathJson || "";
        output.dataset.operation = operation;

        // If a function was defined, register it in the Compute Engine
        if (result.defined_function) {
          _declareUserFunction(result.defined_function);
        }
      } else {
        output.querySelector(".output-label").textContent = "error";
        resultMf.value = "";
        errorDiv.textContent = result.error || "Unknown error";
        output.classList.add("visible");
      }

      _debounceSaveState();

      // Create a new blank cell below (if this was the last cell)
      if (cellId === this.ids[this.ids.length - 1]) {
        this.create();
      } else {
        // Focus next existing cell
        const idx = this.ids.indexOf(cellId);
        if (idx >= 0 && idx < this.ids.length - 1) {
          const nextMf = document.getElementById(
            `${this.ids[idx + 1]}-input`
          );
          if (nextMf) nextMf.focus();
        }
      }
    },
  };

  /**
   * Very rough LaTeX → expression string converter (fallback only).
   * 
   * Handles the most common patterns so sympify() can parse them.
   */
  function _latexToExprString(latex) {
    let s = latex;
    // Strip display-mode wrappers
    s = s.replace(/\\left|\\right/g, "");
    // Fractions:  \frac{a}{b} → ((a)/(b))
    s = s.replace(/\\frac\{([^}]*)}\{([^}]*)}/g, "(($1)/($2))");
    // Powers: ^{n} → **(n)
    s = s.replace(/\^{([^}]*)}/g, "**($1)");
    s = s.replace(/\^(\w)/g, "**$1");
    // Square root: \sqrt{x} → sqrt(x)
    s = s.replace(/\\sqrt\{([^}]*)}/g, "sqrt($1)");
    // Functions
    for (const fn of ["sin", "cos", "tan", "asin", "acos", "atan", "exp", "log", "ln"]) {
      s = s.replace(new RegExp("\\\\" + fn, "g"), fn);
    }
    // \cdot → *
    s = s.replace(/\\cdot/g, "*");
    s = s.replace(/\\times/g, "*");
    s = s.replace(/\\div/g, "/");
    // \pi → pi
    s = s.replace(/\\pi/g, "pi");
    // Spaces
    s = s.replace(/[{}]/g, "");
    s = s.replace(/\s+/g, "");
    // Implicit multiplication aide: 2x → 2*x  (very rough)
    s = s.replace(/(\d)([a-zA-Z])/g, "$1*$2");

    return s || null;
  }

  // Global helper for the DOM insert buttons
  window.MapleCASInsert = function(afterId, type) {
    if (type === 'math') {
      const id = Cells.create("", afterId);
      const mf = document.getElementById(`${id}-input`);
      if (mf) mf.focus();
    } else {
      const id = Cells.createText("", afterId);
      const ed = document.getElementById(`${id}-input`);
      if (ed) ed.focus();
    }
  };

  // ----------------------------------------------------------
  // 5.  PALETTE MANAGER   (left sidebar)
  // ----------------------------------------------------------

  const Palettes = {
    /** Wire up accordion toggles and palette button clicks. */
    init() {
      // Accordion open/close
      document.querySelectorAll(".accordion-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const item = btn.closest(".accordion-item");
          item.classList.toggle("open");
        });
      });

      // Palette button → insert LaTeX into active math-field
      document.querySelectorAll(".palette-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const latex = btn.getAttribute("data-insert");
          if (!latex) return;
          const mf = Cells.getActiveMathField();
          if (mf) {
            mf.insert(latex, {
              focus: true,
              feedback: true,
              selectionMode: "placeholder",
            });
            mf.focus();
          }
        });
      });
    },
  };

  // ----------------------------------------------------------
  // 6.  CONTEXT PANEL   (right sidebar)
  // ----------------------------------------------------------

  const ContextPanel = {
    init() {
      // Wire up action buttons
      document.querySelectorAll(".ctx-btn[data-action]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const action = btn.getAttribute("data-action");
          if (Cells.activeCellId) {
            Cells.evaluateCell(Cells.activeCellId, action);
          }
        });
      });
    },

    /** Update the context panel to reflect the active cell. */
    update(cellId) {
      const varContainer = document.getElementById("var-pills");
      if (!varContainer) return;

      const mf = document.getElementById(`${cellId}-input`);
      if (!mf) {
        varContainer.innerHTML =
          '<span style="color:#94a3b8;font-size:13px;">No variables detected</span>';
        return;
      }

      // Attempt to extract variable names from the LaTeX
      const latex = mf.getValue("latex") || "";
      const vars = _extractVariables(latex);

      if (vars.length === 0) {
        varContainer.innerHTML =
          '<span style="color:#94a3b8;font-size:13px;">Type an expression…</span>';
      } else {
        varContainer.innerHTML = vars
          .map((v) => `<span class="var-pill">${v}</span>`)
          .join("");
      }
    },
  };

  /** Crude extraction of single-letter variable names from LaTeX. */
  function _extractVariables(latex) {
    // Remove known commands
    let s = latex
      .replace(/\\(sin|cos|tan|ln|log|exp|sqrt|frac|pi|cdot|times|div|left|right|int|sum|lim|infty|partial|alpha|beta|gamma|theta|phi|delta|sigma|lambda|omega|mu|epsilon)/g, "")
      .replace(/[\\{}()^_,=+\-*/|<>!&\d\s.]/g, " ");
    const tokens = s.trim().split(/\s+/).filter(Boolean);
    const unique = [...new Set(tokens)].filter(
      (t) => t.length <= 3 && /^[a-zA-Z]/.test(t)
    );
    return unique;
  }

  // ----------------------------------------------------------
  // 7.  HELPERS & STATE
  // ----------------------------------------------------------

  /** Configure a math-field with custom shortcuts and options. */
  function _configureMathField(mf) {
    try {
      // Add := shortcut so typing := inserts \coloneq
      mf.inlineShortcuts = {
        ...mf.inlineShortcuts,
        ":=": "\\coloneq",
        "\\colon=": "\\coloneq",
      };
      // Enable virtual keyboard
      mf.mathVirtualKeyboardPolicy = "auto";
    } catch (e) {
      console.warn("[MapleCAS] Could not configure math-field:", e);
    }
  }

  /** Declare a user-defined function name in the MathLive Compute Engine. */
  function _declareUserFunction(fname) {
    try {
      const ce = window.MathfieldElement && MathfieldElement.computeEngine;
      if (!ce) return;
      try { ce.declare(fname, { signature: { domain: "NumericFunctions" } }); return; } catch (_) {}
      try { ce.declare(fname, { domain: "Functions" }); return; } catch (_) {}
      try { ce.declare(fname, "function"); return; } catch (_) {}
    } catch (e) {
      console.warn("[MapleCAS] Could not declare function:", fname, e);
    }
  }

  // ── Persistence ────────────────────────────────────────────
  const STORAGE_KEY = "maplecas_state";
  let _saveTimer = null;

  function _debounceSaveState() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(_saveState, 500);
  }

  function _saveState() {
    try {
      const title = document.getElementById("doc-title")?.textContent || "Untitled";
      const cells = Cells.ids.map(id => {
        const el = document.getElementById(id);
        const type = el?.dataset.type || "math";
        const input = document.getElementById(`${id}-input`);
        let content = "";
        if (type === "text") {
          content = input?.textContent || "";
        } else {
          content = input?.getValue?.("latex") || "";
        }
        const output = document.getElementById(`${id}-output`);
        const resultLatex = output?.dataset.symbolicLatex || "";
        const resultText = output?.dataset.symbolicText || "";
        return { type, content, resultLatex, resultText };
      });
      const state = { title, cells, savedAt: Date.now() };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn("[MapleCAS] Save state error:", e);
    }
  }

  function _loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const state = JSON.parse(raw);
      if (!state.cells || !state.cells.length) return false;

      const titleEl = document.getElementById("doc-title");
      if (titleEl && state.title) titleEl.textContent = state.title;

      for (const c of state.cells) {
        if (c.type === "text") {
          Cells.createText(c.content);
        } else {
          Cells.create(c.content);
        }
      }
      return true;
    } catch (e) {
      console.warn("[MapleCAS] Load state error:", e);
      return false;
    }
  }

  function _exportWorksheet() {
    const title = document.getElementById("doc-title")?.textContent || "Untitled";
    const cells = Cells.ids.map(id => {
      const el = document.getElementById(id);
      const type = el?.dataset.type || "math";
      const input = document.getElementById(`${id}-input`);
      let content = "";
      if (type === "text") {
        content = input?.textContent || "";
      } else {
        content = input?.getValue?.("latex") || "";
      }
      return { type, content };
    });
    const ws = { title, cells, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(ws, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = title.replace(/[^a-zA-Z0-9]/g, "_") + ".maplecas.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function _importWorksheet() {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".json,.maplecas.json";
    inp.addEventListener("change", () => {
      const file = inp.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const ws = JSON.parse(reader.result);
          if (!ws.cells || !ws.cells.length) return;
          // Clear existing cells
          document.getElementById("document").innerHTML = "";
          Cells.ids.length = 0;
          Cells._counter = 0;

          const titleEl = document.getElementById("doc-title");
          if (titleEl && ws.title) titleEl.textContent = ws.title;

          for (const c of ws.cells) {
            if (c.type === "text") {
              Cells.createText(c.content);
            } else {
              Cells.create(c.content);
            }
          }
          _saveState();
        } catch (e) {
          alert("Failed to load worksheet: " + e.message);
        }
      };
      reader.readAsText(file);
    });
    inp.click();
  }

  // ----------------------------------------------------------
  // 8.  RIBBON BUTTONS
  // ----------------------------------------------------------

  function wireRibbon() {
    _click("btn-new-cell", () => Cells.create());
    _click("btn-new-text", () => Cells.createText());

    _click("btn-evaluate", () => {
      if (Cells.activeCellId) Cells.evaluateCell(Cells.activeCellId);
    });

    _click("btn-evaluate-all", async () => {
      for (const id of Cells.ids) {
        const el = document.getElementById(id);
        if (el?.dataset.type === "text") continue;
        const mf = document.getElementById(`${id}-input`);
        if (mf && (mf.getValue("latex") || "").trim()) {
          await Cells.evaluateCell(id);
        }
      }
    });

    for (const op of ["expand", "factor", "simplify"]) {
      _click(`btn-${op}`, () => {
        if (Cells.activeCellId) Cells.evaluateCell(Cells.activeCellId, op);
      });
    }

    _click("btn-clear", () => {
      document.getElementById("document").innerHTML = "";
      Cells.ids.length = 0;
      Cells._counter = 0;
      Cells.create();
      localStorage.removeItem(STORAGE_KEY);
    });

    _click("btn-save-ws", () => _exportWorksheet());
    _click("btn-load-ws", () => _importWorksheet());
  }

  function _click(id, fn) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", fn);
  }

  // ----------------------------------------------------------
  // DYNAMIC MATRIX PICKER
  // ----------------------------------------------------------

  function _initMatrixPicker() {
    const picker = document.getElementById("matrix-picker");
    if (!picker) return;

    const MAX_R = 6, MAX_C = 6;
    const grid = picker.querySelector(".matrix-grid");
    const label = picker.querySelector(".matrix-label");
    if (!grid || !label) return;

    // Build grid of cells
    for (let r = 0; r < MAX_R; r++) {
      for (let c = 0; c < MAX_C; c++) {
        const cell = document.createElement("div");
        cell.className = "mx-cell";
        cell.dataset.r = r;
        cell.dataset.c = c;
        grid.appendChild(cell);
      }
    }
    grid.style.gridTemplateColumns = `repeat(${MAX_C}, 1fr)`;

    // Highlight on hover
    grid.addEventListener("mouseover", (ev) => {
      const t = ev.target.closest(".mx-cell");
      if (!t) return;
      const hr = +t.dataset.r;
      const hc = +t.dataset.c;
      grid.querySelectorAll(".mx-cell").forEach((cell) => {
        const cr = +cell.dataset.r;
        const cc = +cell.dataset.c;
        cell.classList.toggle("active", cr <= hr && cc <= hc);
      });
      label.textContent = `${hr + 1}\u00d7${hc + 1}`;
    });

    // Click to insert matrix
    grid.addEventListener("click", (ev) => {
      const t = ev.target.closest(".mx-cell");
      if (!t) return;
      const rows = +t.dataset.r + 1;
      const cols = +t.dataset.c + 1;

      // Build LaTeX for the matrix
      const rowStrs = [];
      for (let r = 0; r < rows; r++) {
        const cells = [];
        for (let c = 0; c < cols; c++) {
          cells.push("\\placeholder{}");
        }
        rowStrs.push(cells.join(" & "));
      }
      const latex = `\\begin{bmatrix} ${rowStrs.join(" \\\\ ")} \\end{bmatrix}`;

      const mf = Cells.getActiveMathField();
      if (mf) {
        mf.insert(latex, { focus: true, feedback: true, selectionMode: "placeholder" });
        mf.focus();
      }
      // Close the picker
      picker.classList.remove("open");
    });

    // Toggle open/close
    const trigger = document.getElementById("matrix-picker-trigger");
    if (trigger) {
      trigger.addEventListener("click", () => {
        picker.classList.toggle("open");
      });
      // Close when clicking outside
      document.addEventListener("click", (ev) => {
        if (!picker.contains(ev.target) && ev.target !== trigger) {
          picker.classList.remove("open");
        }
      });
    }
  }

  // ----------------------------------------------------------
  // 9.  INITIALIZATION
  // ----------------------------------------------------------

  async function init() {
    wireRibbon();
    Palettes.init();
    ContextPanel.init();
    _initMatrixPicker();

    // Open first accordion sections by default
    document
      .querySelectorAll(".accordion-item:first-child")
      .forEach((el) => el.classList.add("open"));

    // Restore saved state or create a blank cell
    const restored = _loadState();
    if (!restored) Cells.create();

    // Auto-save title changes
    const titleEl = document.getElementById("doc-title");
    if (titleEl) titleEl.addEventListener("input", () => _debounceSaveState());

    // Boot Pyodide (non-blocking)
    await Pyodide.init();

    const overlay = document.getElementById("loading-overlay");
    if (overlay) overlay.classList.add("hidden");
  }

  // Kick off when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
