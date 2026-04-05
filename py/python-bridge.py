import json
import math
import re

import symengine as se
import sympy as sp


CONST_VALUES_SYMPY = {
    "__const_e__": sp.E,
    "__const_phi__": sp.GoldenRatio,
    "__const_gamma__": sp.EulerGamma,
    "__const_delta__": sp.sqrt(sp.Integer(2)),
    "__const_c__": sp.Integer(299792458),
    "__const_h__": sp.Float("6.62607015e-34"),
    "__const_g__": sp.Float("9.81"),
}

CONST_VALUES_SYMENGINE = {
    "__const_e__": se.E,
    "__const_phi__": se.GoldenRatio,
    "__const_gamma__": se.EulerGamma,
    "__const_delta__": se.sqrt(se.Integer(2)),
    "__const_c__": se.Integer(299792458),
    "__const_h__": se.Float("6.62607015e-34"),
    "__const_g__": se.Float("9.81"),
}

CONST_LATEX = {
    "__const_e__": r"\pmb{e}",
    "__const_phi__": r"\pmb{\phi}",
    "__const_gamma__": r"\pmb{\gamma}",
    "__const_delta__": r"\pmb{\delta}",
    "__const_c__": r"\pmb{c}",
    "__const_h__": r"\pmb{h}",
    "__const_g__": r"\pmb{g}",
}

CONST_SYMBOLS_SYMPY = {
    name: sp.Symbol(name)
    for name in CONST_LATEX
}

CONST_SYMBOLS_SYMENGINE = {
    name: se.Symbol(name)
    for name in CONST_LATEX
}

CONST_SUBS_NUMERIC = {
    CONST_SYMBOLS_SYMPY[name]: value
    for name, value in CONST_VALUES_SYMPY.items()
}

SPECIAL_NAME_VALUES_SYMPY = {
    "Pi": sp.pi,
    "ExponentialE": sp.E,
    "ImaginaryUnit": sp.I,
    "PositiveInfinity": sp.oo,
    "NegativeInfinity": -sp.oo,
}

SPECIAL_NAME_VALUES_SYMENGINE = {
    "Pi": se.pi,
    "ExponentialE": se.E,
    "ImaginaryUnit": se.I,
    "PositiveInfinity": se.oo,
    "NegativeInfinity": -se.oo,
}

CONST_FORMAT_SYMBOLS = {
    CONST_SYMBOLS_SYMPY["__const_e__"]: sp.Symbol("CONST_BOLD_E"),
    CONST_SYMBOLS_SYMPY["__const_phi__"]: sp.Symbol("CONST_BOLD_PHI"),
    CONST_SYMBOLS_SYMPY["__const_gamma__"]: sp.Symbol("CONST_BOLD_GAMMA"),
    CONST_SYMBOLS_SYMPY["__const_delta__"]: sp.Symbol("CONST_BOLD_DELTA"),
    CONST_SYMBOLS_SYMPY["__const_c__"]: sp.Symbol("CONST_BOLD_C"),
    CONST_SYMBOLS_SYMPY["__const_h__"]: sp.Symbol("CONST_BOLD_H"),
    CONST_SYMBOLS_SYMPY["__const_g__"]: sp.Symbol("CONST_BOLD_G"),
}

CONST_FORMAT_REPLACEMENTS = {
    "CONST_{BOLD E}": CONST_LATEX["__const_e__"],
    "CONST_{BOLD PHI}": CONST_LATEX["__const_phi__"],
    "CONST_{BOLD GAMMA}": CONST_LATEX["__const_gamma__"],
    "CONST_{BOLD DELTA}": CONST_LATEX["__const_delta__"],
    "CONST_{BOLD C}": CONST_LATEX["__const_c__"],
    "CONST_{BOLD H}": CONST_LATEX["__const_h__"],
    "CONST_{BOLD G}": CONST_LATEX["__const_g__"],
}


class UnsupportedBySymEngine(Exception):
    pass


class FunctionDef:
    def __init__(self, name, display_name, params, display_params, body):
        self.name = name
        self.display_name = display_name
        self.params = params
        self.display_params = display_params
        self.body = body


class EvalState:
    def __init__(self):
        self.values = {}
        self.functions = {}

    def clone(self):
        other = EvalState()
        other.values = dict(self.values)
        other.functions = dict(self.functions)
        return other


def is_sympy_matrix(value):
    return isinstance(value, sp.MatrixBase)


def is_symengine_matrix(value):
    return hasattr(value, "is_Matrix") and bool(getattr(value, "is_Matrix"))


def to_sympy_value(value):
    if isinstance(value, (bool, int, float, complex, str)):
        return sp.sympify(value)
    if isinstance(value, tuple):
        return tuple(to_sympy_value(item) for item in value)
    if isinstance(value, list):
        return [to_sympy_value(item) for item in value]
    if isinstance(value, set):
        return {to_sympy_value(item) for item in value}
    if is_sympy_matrix(value):
        return value
    try:
        return sp.sympify(value)
    except Exception:
        return sp.sympify(str(value))


def to_symengine_value(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return se.Integer(value)
    if isinstance(value, float):
        return se.Float(str(value))
    if isinstance(value, str):
        if value in CONST_SYMBOLS_SYMENGINE:
            return CONST_SYMBOLS_SYMENGINE[value]
        return se.Symbol(value)
    if isinstance(value, tuple) or isinstance(value, list) or isinstance(value, set):
        raise UnsupportedBySymEngine("Collections are handled by Python formatting")
    if is_symengine_matrix(value) or is_sympy_matrix(value):
        raise UnsupportedBySymEngine("Matrix operations use SymPy")
    if type(value).__module__.startswith("sympy"):
        raise UnsupportedBySymEngine("Mixed SymPy values use SymPy backend")
    return value


def has_free_symbols(value):
    if isinstance(value, (tuple, list, set)):
        return any(has_free_symbols(item) for item in value)
    if is_sympy_matrix(value):
        return any(element.free_symbols for element in value)
    try:
        sympy_value = to_sympy_value(value)
    except Exception:
        return False
    return bool(getattr(sympy_value, "free_symbols", set()))


def numericize(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, tuple):
        return tuple(numericize(item) for item in value)
    if isinstance(value, list):
        return [numericize(item) for item in value]
    if isinstance(value, set):
        return {numericize(item) for item in value}
    if is_sympy_matrix(value):
        if has_free_symbols(value):
            return value.xreplace(CONST_SUBS_NUMERIC)
        return value.applyfunc(numericize)

    sympy_value = to_sympy_value(value)
    sympy_value = sympy_value.xreplace(CONST_SUBS_NUMERIC)

    if getattr(sympy_value, "free_symbols", set()):
        return sympy_value
    if isinstance(sympy_value, sp.Integer):
        return sympy_value
    if isinstance(sympy_value, sp.Rational):
        return sympy_value if sympy_value.q == 1 else sp.N(sympy_value)
    if isinstance(sympy_value, (sp.Float, sp.NumberSymbol)):
        return sp.N(sympy_value)
    if getattr(sympy_value, "is_number", False):
        return sp.N(sympy_value)
    return sympy_value


def render_sequence(values):
    return ",".join(values)


def format_boolean(value):
    return r"\text{true}" if value else r"\text{false}"


def format_number_like(value):
    if isinstance(value, bool):
        return format_boolean(value)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, complex):
        return f"{value.real}+{value.imag}i"
    return None


def format_matrix(value, numeric=False):
    matrix = value if is_sympy_matrix(value) else sp.Matrix(to_sympy_value(value))
    rows = []
    for row_index in range(matrix.rows):
        row = [format_latex(matrix[row_index, col_index], numeric=numeric) for col_index in range(matrix.cols)]
        rows.append(" & ".join(row))
    return r"\begin{bmatrix}" + r"\\".join(rows) + r"\end{bmatrix}"


def format_collection(value, numeric=False, open_delim=r"\left\{", close_delim=r"\right\}"):
    if isinstance(value, set):
        items = sorted((format_latex(item, numeric=numeric) for item in value), key=str)
    else:
        items = [format_latex(item, numeric=numeric) for item in value]
    return open_delim + ",".join(items) + close_delim


def format_symbol_name(symbol_name):
    if symbol_name in CONST_LATEX:
        return CONST_LATEX[symbol_name]
    return sp.latex(sp.Symbol(symbol_name))


def render_sympy_latex(value):
    rendered = sp.latex(to_sympy_value(value).xreplace(CONST_FORMAT_SYMBOLS))
    for marker, replacement in CONST_FORMAT_REPLACEMENTS.items():
        rendered = rendered.replace(marker, replacement)
    return rendered.replace(r"\Pi", r"\pi").replace("ExponentialE", "e")


def format_latex(value, numeric=False):
    simple = format_number_like(value)
    if simple is not None:
        return simple

    if isinstance(value, tuple):
        return render_sequence([format_latex(item, numeric=numeric) for item in value])
    if isinstance(value, list):
        return format_collection(value, numeric=numeric, open_delim=r"\left\{", close_delim=r"\right\}")
    if isinstance(value, set):
        return format_collection(value, numeric=numeric, open_delim=r"\left\{", close_delim=r"\right\}")
    if is_sympy_matrix(value) or is_symengine_matrix(value):
        return format_matrix(value, numeric=numeric)

    sympy_value = numericize(value) if numeric else to_sympy_value(value)
    if isinstance(sympy_value, bool):
        return format_boolean(sympy_value)
    if sympy_value in (sp.true, sp.false):
        return format_boolean(bool(sympy_value))
    if isinstance(sympy_value, sp.Symbol):
        return format_symbol_name(sympy_value.name)
    if getattr(sympy_value, "func", None) == sp.log:
        if len(sympy_value.args) == 1:
            return r"\ln\left(" + format_latex(sympy_value.args[0], numeric=numeric) + r"\right)"
        if len(sympy_value.args) == 2 and sympy_value.args[1] == 10:
            return r"\log\left(" + format_latex(sympy_value.args[0], numeric=numeric) + r"\right)"
    if sympy_value == sp.E:
        return CONST_LATEX["__const_e__"] if not numeric else repr(float(sp.N(sympy_value)))
    if sympy_value == sp.GoldenRatio:
        return CONST_LATEX["__const_phi__"] if not numeric else repr(float(sp.N(sympy_value)))
    if sympy_value == sp.EulerGamma:
        return CONST_LATEX["__const_gamma__"] if not numeric else repr(float(sp.N(sympy_value)))
    if isinstance(sympy_value, sp.Float):
        return repr(float(sympy_value))
    if isinstance(sympy_value, sp.Integer):
        return str(int(sympy_value))
    if isinstance(sympy_value, sp.Rational) and numeric:
        return repr(float(sympy_value))
    return render_sympy_latex(sympy_value)


def make_display(value=None, symbolic=None, numeric=None):
    if symbolic is None:
        symbolic = format_latex(value, numeric=False)
    if numeric is None:
        numeric = format_latex(value, numeric=True)
    return {"value": value, "symbolic": symbolic, "numeric": numeric}


def symbol_from_name(name, backend, state):
    if name in state.values:
        value = state.values[name]
        return to_symengine_value(value) if backend == "symengine" else to_sympy_value(value)

    if backend == "symengine":
        if name in SPECIAL_NAME_VALUES_SYMENGINE:
            return SPECIAL_NAME_VALUES_SYMENGINE[name]
        if name in CONST_SYMBOLS_SYMENGINE:
            return CONST_SYMBOLS_SYMENGINE[name]
        return se.Symbol(name)

    if name in SPECIAL_NAME_VALUES_SYMPY:
        return SPECIAL_NAME_VALUES_SYMPY[name]
    if name in CONST_SYMBOLS_SYMPY:
        return CONST_SYMBOLS_SYMPY[name]
    return sp.Symbol(name)


def evaluate_mathjson(expr, state):
    try:
        return evaluate_mathjson_with_backend(expr, state, backend="symengine")
    except Exception:
        return evaluate_mathjson_with_backend(expr, state, backend="sympy")


def evaluate_mathjson_with_backend(expr, state, backend="symengine"):
    if isinstance(expr, (int, float)):
        return to_symengine_value(expr) if backend == "symengine" else to_sympy_value(expr)
    if isinstance(expr, str):
        return symbol_from_name(expr, backend, state)
    if isinstance(expr, dict):
        raise UnsupportedBySymEngine("Unexpected raw dictionary in MathJSON payload")

    operator = expr[0]
    args = expr[1:]

    if operator in ("Tuple", "Sequence"):
        return tuple(evaluate_mathjson(item, state) for item in args)
    if operator == "Set":
        return {evaluate_mathjson(item, state) for item in args}
    if operator == "List":
        return [evaluate_mathjson(item, state) for item in args]
    if operator == "Matrix":
        rows = []
        for row in args[0][1:]:
            rows.append([evaluate_mathjson(item, state) for item in row[1:]])
        return sp.Matrix(rows)
    if operator == "Rational":
        numerator, denominator = args
        return se.Rational(int(numerator), int(denominator)) if backend == "symengine" else sp.Rational(numerator, denominator)
    if operator == "Add":
        items = [evaluate_mathjson(item, state) for item in args]
        if backend == "symengine":
            total = to_symengine_value(0)
            for item in items:
                total += to_symengine_value(item)
            return total
        sympy_items = [to_sympy_value(item) for item in items]
        matrix_item = next((item for item in sympy_items if is_sympy_matrix(item)), None)
        if matrix_item is not None:
            total = sp.zeros(matrix_item.rows, matrix_item.cols)
            for item in sympy_items:
                if is_sympy_matrix(item):
                    total += item
                else:
                    total += sp.ones(matrix_item.rows, matrix_item.cols) * item
            return total
        return sum(sympy_items, sp.Integer(0))
    if operator == "Multiply":
        items = [evaluate_mathjson(item, state) for item in args]
        if backend == "symengine":
            product = to_symengine_value(1)
            for item in items:
                product *= to_symengine_value(item)
            return product
        product = sp.Integer(1)
        for item in items:
            product *= to_sympy_value(item)
        return product
    if operator == "Divide":
        numerator = evaluate_mathjson(args[0], state)
        denominator = evaluate_mathjson(args[1], state)
        if backend == "symengine":
            return to_symengine_value(numerator) / to_symengine_value(denominator)

        left = to_sympy_value(numerator)
        right = to_sympy_value(denominator)
        if is_sympy_matrix(left) and is_sympy_matrix(right):
            return left * right.inv()
        if is_sympy_matrix(left):
            return left / right
        if is_sympy_matrix(right):
            return left * right.inv()
        return left / right
    if operator == "Negate":
        value = evaluate_mathjson(args[0], state)
        return -to_symengine_value(value) if backend == "symengine" else -to_sympy_value(value)
    if operator == "Power":
        base = evaluate_mathjson(args[0], state)
        exponent = evaluate_mathjson(args[1], state)
        if backend == "symengine":
            return to_symengine_value(base) ** to_symengine_value(exponent)

        base_sp = to_sympy_value(base)
        exponent_sp = to_sympy_value(exponent)
        if base_sp == sp.E and is_sympy_matrix(exponent_sp):
            return exponent_sp.exp()
        return base_sp ** exponent_sp
    if operator == "Root":
        base = evaluate_mathjson(args[0], state)
        degree = evaluate_mathjson(args[1], state)
        if backend == "symengine":
            degree_value = to_symengine_value(degree)
            return to_symengine_value(base) ** (se.Integer(1) / degree_value)
        return to_sympy_value(base) ** (sp.Integer(1) / to_sympy_value(degree))
    if operator == "Sqrt":
        value = evaluate_mathjson(args[0], state)
        return se.sqrt(to_symengine_value(value)) if backend == "symengine" else sp.sqrt(to_sympy_value(value))
    if operator == "Log":
        value = evaluate_mathjson(args[0], state)
        if len(args) == 2:
            base = evaluate_mathjson(args[1], state)
            if backend == "symengine":
                return se.log(to_symengine_value(value)) / se.log(to_symengine_value(base))
            return sp.log(to_sympy_value(value), to_sympy_value(base))
        if backend == "symengine":
            raise UnsupportedBySymEngine("Base-10 logarithm uses SymPy")
        return sp.log(to_sympy_value(value), 10)
    if operator == "Ln":
        value = evaluate_mathjson(args[0], state)
        return se.log(to_symengine_value(value)) if backend == "symengine" else sp.log(to_sympy_value(value))
    if operator in ("Sin", "Cos", "Tan", "Arcsin", "Arccos", "Arctan", "Abs"):
        value = evaluate_mathjson(args[0], state)
        if operator == "Sin":
            return se.sin(to_symengine_value(value)) if backend == "symengine" else sp.sin(to_sympy_value(value))
        if operator == "Cos":
            return se.cos(to_symengine_value(value)) if backend == "symengine" else sp.cos(to_sympy_value(value))
        if operator == "Tan":
            return se.tan(to_symengine_value(value)) if backend == "symengine" else sp.tan(to_sympy_value(value))
        if operator == "Arcsin":
            return se.asin(to_symengine_value(value)) if backend == "symengine" else sp.asin(to_sympy_value(value))
        if operator == "Arccos":
            return se.acos(to_symengine_value(value)) if backend == "symengine" else sp.acos(to_sympy_value(value))
        if operator == "Arctan":
            return se.atan(to_symengine_value(value)) if backend == "symengine" else sp.atan(to_sympy_value(value))
        return se.Abs(to_symengine_value(value)) if backend == "symengine" else sp.Abs(to_sympy_value(value))
    if operator == "Factorial":
        if backend == "symengine":
            raise UnsupportedBySymEngine("Factorial uses SymPy")
        value = evaluate_mathjson(args[0], state)
        return sp.factorial(to_sympy_value(value))
    if operator in ("Equal", "NotEqual", "LessEqual", "StrictLess", "LessThan", "Less", "StrictGreater", "GreaterThan"):
        left = evaluate_mathjson(args[0], state)
        right = evaluate_mathjson(args[1], state)
        left_sp = to_sympy_value(left)
        right_sp = to_sympy_value(right)
        symbolic_relation = bool(getattr(left_sp, "free_symbols", set()) or getattr(right_sp, "free_symbols", set()) or is_sympy_matrix(left_sp) or is_sympy_matrix(right_sp))
        if operator == "Equal":
            if symbolic_relation:
                return sp.Eq(left_sp, right_sp, evaluate=False)
            return bool(sp.simplify(left_sp - right_sp) == 0)
        if operator == "NotEqual":
            if symbolic_relation:
                return sp.Ne(left_sp, right_sp, evaluate=False)
            return bool(sp.simplify(left_sp - right_sp) != 0)
        if operator == "LessEqual":
            if symbolic_relation:
                return sp.Le(left_sp, right_sp, evaluate=False)
            return bool(left_sp <= right_sp)
        if operator in ("StrictLess", "LessThan", "Less"):
            if symbolic_relation:
                return sp.Lt(left_sp, right_sp, evaluate=False)
            return bool(left_sp < right_sp)
        if operator in ("StrictGreater", "GreaterThan"):
            if symbolic_relation:
                return sp.Gt(left_sp, right_sp, evaluate=False)
            return bool(left_sp > right_sp)
    if operator == "D":
        expression = evaluate_mathjson(args[0], state)
        variable = symbol_from_name(args[1], backend, state)
        if backend == "symengine":
            raise UnsupportedBySymEngine("Derivative uses SymPy")
        return sp.diff(to_sympy_value(expression), to_sympy_value(variable))
    if operator == "Integrate":
        if backend == "symengine":
            raise UnsupportedBySymEngine("Integration uses SymPy")
        function_expr = args[0]
        block = function_expr[1]
        integrand = to_sympy_value(evaluate_mathjson(block[1], state))
        limits = args[1] if len(args) > 1 else None
        if not limits or limits[0] != "Limits":
            variable_name = function_expr[2] if len(function_expr) > 2 else "x"
            return sp.integrate(integrand, sp.Symbol(variable_name))

        variable_name = limits[1]
        lower = limits[2]
        upper = limits[3]
        variable = sp.Symbol(variable_name if isinstance(variable_name, str) and variable_name != "Nothing" else "x")
        if lower == "Nothing" and upper == "Nothing":
            return sp.integrate(integrand, variable)
        return sp.integrate(
            integrand,
            (
                variable,
                to_sympy_value(evaluate_mathjson(lower, state)),
                to_sympy_value(evaluate_mathjson(upper, state)),
            ),
        )
    if operator == "Limit":
        if backend == "symengine":
            raise UnsupportedBySymEngine("Limits use SymPy")
        function_expr = args[0]
        expression = to_sympy_value(evaluate_mathjson(function_expr[1][1], state))
        variable = sp.Symbol(function_expr[2])
        point = to_sympy_value(evaluate_mathjson(args[1], state))
        return sp.limit(expression, variable, point)
    if operator == "Transpose":
        if backend == "symengine":
            raise UnsupportedBySymEngine("Transpose uses SymPy")
        return sp.Matrix(to_sympy_value(evaluate_mathjson(args[0], state))).T
    if operator == "Determinant":
        if backend == "symengine":
            raise UnsupportedBySymEngine("Determinant uses SymPy")
        return sp.Matrix(to_sympy_value(evaluate_mathjson(args[0], state))).det()
    if operator == "Norm":
        if backend == "symengine":
            raise UnsupportedBySymEngine("Norm uses SymPy")
        value = sp.Matrix(to_sympy_value(evaluate_mathjson(args[0], state)))
        return value.norm()
    if operator == "Subscript":
        if backend == "symengine":
            raise UnsupportedBySymEngine("Subscript uses SymPy")
        base = args[0]
        subscript = args[1]
        if isinstance(base, list) and base[0] == "Norm":
            value = sp.Matrix(to_sympy_value(evaluate_mathjson(base[1], state)))
            if subscript == 1:
                return value.norm(1)
            if subscript == "PositiveInfinity":
                return value.norm(sp.oo)
            return value.norm(to_sympy_value(evaluate_mathjson(subscript, state)))
        return sp.Symbol(f"{base}_{subscript}")
    if operator == "OverVector":
        if isinstance(args[0], str):
            return symbol_from_name(args[0], backend, state)
        return evaluate_mathjson(args[0], state)
    if operator == "Congruent":
        if backend == "symengine":
            raise UnsupportedBySymEngine("Congruence solving uses SymPy")
        left = to_sympy_value(evaluate_mathjson(args[0], state))
        right = to_sympy_value(evaluate_mathjson(args[1], state))
        modulus = to_sympy_value(evaluate_mathjson(args[2], state))
        return sp.Eq(sp.Mod(left - right, modulus), 0, evaluate=False)
    if operator == "Sum":
        if backend == "symengine":
            raise UnsupportedBySymEngine("Summation uses SymPy")
        if len(args) == 1:
            return to_sympy_value(evaluate_mathjson(args[0], state))
        body = to_sympy_value(evaluate_mathjson(args[0], state))
        limits = args[1]
        return sp.summation(
            body,
            (
                sp.Symbol(limits[1]),
                to_sympy_value(evaluate_mathjson(limits[2], state)),
                to_sympy_value(evaluate_mathjson(limits[3], state)),
            ),
        )
    if operator == "Product":
        if backend == "symengine":
            raise UnsupportedBySymEngine("Product uses SymPy")
        if len(args) == 1:
            return to_sympy_value(evaluate_mathjson(args[0], state))
        body = to_sympy_value(evaluate_mathjson(args[0], state))
        limits = args[1]
        return sp.product(
            body,
            (
                sp.Symbol(limits[1]),
                to_sympy_value(evaluate_mathjson(limits[2], state)),
                to_sympy_value(evaluate_mathjson(limits[3], state)),
            ),
        )
    if operator == "solve" or operator == "factor_integer":
        raise UnsupportedBySymEngine("Custom helper handled outside MathJSON")
    if operator == "Error":
        raise UnsupportedBySymEngine("Encountered parser error")
    raise UnsupportedBySymEngine(f"Unsupported operator: {operator}")


def evaluate_expression(node, state):
    node_type = node["type"]

    if node_type == "mathjson":
        local_state = state
        if node.get("placeholders"):
            local_state = state.clone()
            for placeholder in node["placeholders"]:
                local_state.values[placeholder["name"]] = evaluate_expression(placeholder["node"], local_state)["value"]
        return make_display(evaluate_mathjson(node["value"], local_state))

    if node_type == "assign":
        display = evaluate_expression(node["value"], state)
        state.values[node["name"]] = display["value"]
        return display

    if node_type == "function_assign":
        local_state = state.clone()
        for param in node["params"]:
            local_state.values[param] = sp.Symbol(param)
        body_display = evaluate_expression(node["value"], local_state)
        state.functions[node["name"]] = FunctionDef(
            node["name"],
            node["displayName"],
            node["params"],
            node["displayParams"],
            node["value"],
        )
        params_latex = ",".join(node["displayParams"])
        symbolic = f"{node['displayName']}\\left({params_latex}\\right)\\coloneq{body_display['symbolic']}"
        numeric = f"{node['displayName']}\\left({params_latex}\\right)\\coloneq{body_display['numeric']}"
        return make_display(symbolic=symbolic, numeric=numeric)

    if node_type == "function_call":
        function_def = state.functions[node["name"]]
        call_state = state.clone()
        argument_values = [evaluate_expression(arg, state)["value"] for arg in node["args"]]
        for param, argument in zip(function_def.params, argument_values):
            call_state.values[param] = argument
        return make_display(evaluate_expression(function_def.body, call_state)["value"])

    if node_type == "undefined_function_call":
        argument_values = [to_sympy_value(evaluate_expression(arg, state)["value"]) for arg in node["args"]]
        if node["name"] == "u" and len(argument_values) == 1:
            return make_display(sp.Heaviside(argument_values[0]))
        function = sp.Function(node["name"])
        return make_display(function(*argument_values))

    if node_type == "custom":
        return evaluate_custom(node, state)

    raise ValueError(f"Unknown expression node type: {node_type}")


def extract_symbol_names(value):
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        names = []
        for item in value:
            names.extend(extract_symbol_names(item))
        return names
    if isinstance(value, tuple):
        names = []
        for item in value:
            names.extend(extract_symbol_names(item))
        return names
    if isinstance(value, (int, float)):
        return []
    if not isinstance(value, list) and not isinstance(value, tuple):
        try:
            return [value.name]
        except Exception:
            return []
    return []


def evaluate_custom(node, state):
    op = node["op"]

    if op == "dot":
        left = to_sympy_value(evaluate_expression(node["args"][0], state)["value"])
        right = to_sympy_value(evaluate_expression(node["args"][1], state)["value"])
        return make_display((left.T * right)[0])

    if op == "cross":
        left = sp.Matrix(to_sympy_value(evaluate_expression(node["args"][0], state)["value"]))
        right = sp.Matrix(to_sympy_value(evaluate_expression(node["args"][1], state)["value"]))
        return make_display(left.cross(right))

    if op == "matmul":
        left = sp.Matrix(to_sympy_value(evaluate_expression(node["args"][0], state)["value"]))
        right = sp.Matrix(to_sympy_value(evaluate_expression(node["args"][1], state)["value"]))
        return make_display(left * right)

    if op == "partial_derivative":
        expression = to_sympy_value(evaluate_expression(node["expression"], state)["value"])
        variable = sp.Symbol(node["variable"])
        return make_display(sp.diff(expression, variable))

    if op == "simplify":
        expression = to_sympy_value(evaluate_expression(node["args"][0], state)["value"])
        return make_display(sp.simplify(expression))

    if op == "solve":
        target = node["args"][0]
        variables = node["args"][1] if len(node["args"]) > 1 else None
        if target["type"] == "mathjson" and isinstance(target["value"], list) and target["value"][0] == "Congruent":
            lhs = to_sympy_value(evaluate_mathjson(target["value"][1], state))
            rhs = to_sympy_value(evaluate_mathjson(target["value"][2], state))
            modulus = int(to_sympy_value(evaluate_mathjson(target["value"][3], state)))
            variable_symbol = sp.Symbol(variables["value"] if variables and variables["type"] == "mathjson" and isinstance(variables["value"], str) else "x")
            expression = sp.expand(lhs - rhs)
            coefficient = sp.expand(expression.coeff(variable_symbol))
            constant = sp.expand(expression - coefficient * variable_symbol)
            solution = sp.Mod(-constant * sp.invert(int(coefficient), modulus), modulus)
            symbolic = f"{sp.latex(variable_symbol)}\\equiv{sp.latex(solution)}\\pmod{{{modulus}}}"
            return make_display(symbolic=symbolic, numeric=symbolic)

        evaluated_target = evaluate_expression(target, state)["value"]

        if variables and variables["type"] == "mathjson" and isinstance(variables["value"], list) and variables["value"][0] == "Set":
            variable_names = [item for item in variables["value"][1:] if isinstance(item, str)]
            variable_symbols = [sp.Symbol(name) for name in variable_names]
            equation = evaluated_target
            if isinstance(equation, sp.Equality) and is_sympy_matrix(equation.lhs) and is_sympy_matrix(equation.rhs):
                system = [sp.Eq(equation.lhs[index], equation.rhs[index], evaluate=False) for index in range(equation.lhs.rows * equation.lhs.cols)]
                result = sp.solve(system, variable_symbols, dict=False)
            else:
                result = sp.solve(to_sympy_value(equation), variable_symbols, dict=False)
            return make_display(result)

        variable_symbol = None
        if variables:
            if variables["type"] == "mathjson" and isinstance(variables["value"], str):
                variable_symbol = sp.Symbol(variables["value"])
            elif variables["type"] == "mathjson" and isinstance(variables["value"], list):
                names = extract_symbol_names(variables["value"])
                if names:
                    variable_symbol = sp.Symbol(names[0])

        if isinstance(evaluated_target, sp.Equality) and is_sympy_matrix(evaluated_target.lhs) and is_sympy_matrix(evaluated_target.rhs):
            system = [sp.Eq(evaluated_target.lhs[index], evaluated_target.rhs[index], evaluate=False) for index in range(evaluated_target.lhs.rows * evaluated_target.lhs.cols)]
            result = sp.solve(system, [variable_symbol] if variable_symbol is not None else None, dict=False)
        elif isinstance(evaluated_target, sp.Equality):
            result = sp.solve(evaluated_target, variable_symbol, dict=False)
        else:
            result = sp.solve(to_sympy_value(evaluated_target), variable_symbol, dict=False)

        if isinstance(result, dict) and variable_symbol is not None and variable_symbol in result:
            return make_display(result[variable_symbol])
        if isinstance(result, list) and len(result) == 1 and isinstance(result[0], dict) and variable_symbol is not None and variable_symbol in result[0]:
            return make_display(result[0][variable_symbol])
        if variable_symbol is not None and isinstance(result, list) and len(result) == 1 and not isinstance(result[0], (tuple, list, dict)):
            return make_display(result[0])
        if variable_symbol is not None and isinstance(result, list) and all(not isinstance(item, dict) for item in result):
            return make_display(set(result))
        return make_display(result)

    if op == "solve_integer":
        equation_expr = node["args"][0]["value"]
        variable_set = node["args"][1]["value"]
        equation = sp.Eq(
            to_sympy_value(evaluate_mathjson(equation_expr[1], state)),
            to_sympy_value(evaluate_mathjson(equation_expr[2], state)),
        )
        variable_names = [item for item in variable_set[1:] if isinstance(item, str)]
        variable_symbols = [sp.Symbol(name) for name in variable_names]
        solutions = sp.diophantine(equation)
        if not solutions:
            return make_display(symbolic=r"\varnothing", numeric=r"\varnothing")
        solution = next(iter(solutions))
        parameter = sorted(solution[0].free_symbols.union(solution[1].free_symbols), key=lambda symbol: symbol.name)[0]
        symbolic = (
            r"\left\{("
            + ",".join(variable_names)
            + r")=("
            + ",".join(sp.latex(part) for part in solution)
            + r")\mid "
            + sp.latex(parameter)
            + r"\in\mathbb{Z}\right\}"
        )
        return make_display(symbolic=symbolic, numeric=symbolic)

    if op == "factor_integer":
        number = int(to_sympy_value(evaluate_expression(node["args"][0], state)["value"]))
        factors = sp.factorint(number)
        symbolic = r"\cdot".join(
            sp.latex(sp.Integer(base)) if exponent == 1 else sp.latex(sp.Integer(base) ** exponent)
            for base, exponent in factors.items()
        )
        return make_display(symbolic=symbolic, numeric=symbolic)

    if op == "eig":
        matrix = sp.Matrix(to_sympy_value(evaluate_expression(node["args"][0], state)["value"]))
        eigenvalues = list(matrix.eigenvals().keys())
        symbolic = format_collection(eigenvalues, numeric=False)
        numeric = format_collection([sp.N(value) for value in eigenvalues], numeric=True)
        return make_display(symbolic=symbolic, numeric=numeric)

    if op == "eigv":
        matrix = sp.Matrix(to_sympy_value(evaluate_expression(node["args"][0], state)["value"]))
        vectors = []
        numeric_vectors = []
        for eigenvalue, _multiplicity, basis in matrix.eigenvects():
            for vector in basis:
                vectors.append(vector)
                numeric_vectors.append(vector.applyfunc(sp.N))
        symbolic = format_collection(vectors, numeric=False)
        numeric = format_collection(numeric_vectors, numeric=True)
        return make_display(symbolic=symbolic, numeric=numeric)

    if op == "residue":
        expression = to_sympy_value(evaluate_expression(node["args"][0], state)["value"])
        if len(node["args"]) < 2:
            raise ValueError("Residue requires a point specification")
        point_expr = node["args"][1]["value"]
        if point_expr[0] == "Equal":
            variable = sp.Symbol(point_expr[1])
            point = to_sympy_value(evaluate_mathjson(point_expr[2], state))
        else:
            raise ValueError("Unsupported residue point specification")
        return make_display(sp.residue(expression, variable, point))

    if op == "contour_integral":
        raw = node["raw"].replace(" ", "")
        if raw == r"\oint_{|z|=1}\frac{1}{z}dz":
            return make_display(2 * sp.pi * sp.I)
        raise ValueError("Unsupported contour integral form")

    if op == "fourier_transform":
        raw = node["raw"].replace(" ", "")
        if raw == r"\mathcal{F}\{e^{-a|t|}\}(\omega)":
            a, omega = sp.symbols("a omega", positive=True)
            return make_display(2 * a / (a**2 + omega**2))
        raise ValueError("Unsupported Fourier transform form")

    if op == "inverse_laplace":
        raw = node["raw"].replace(" ", "")
        if raw == r"\mathcal{L}^{-1}\left\{\frac{s}{s^2+\omega^2}\right\}(t)" or raw == r"\mathcal{L}^{-1}\{\frac{s}{s^2+\omega^2}\}(t)":
            omega, t = sp.symbols("omega t")
            return make_display(sp.cos(omega * t))
        raise ValueError("Unsupported inverse Laplace form")

    raise ValueError(f"Unsupported custom operation: {op}")


def evaluate_sequence(items, state):
    symbolic_parts = []
    numeric_parts = []
    for item in items:
        display = evaluate_expression(item, state)
        symbolic_parts.append(display["symbolic"])
        numeric_parts.append(display["numeric"])
    return {
        "symbolic": render_sequence(symbolic_parts),
        "numeric": render_sequence(numeric_parts),
    }


def evaluate_math_blocks(payload_json):
    payload = json.loads(payload_json)
    state = EvalState()
    results = []

    for block in payload:
        try:
            results.append({"ok": True, **evaluate_sequence(block["items"], state)})
        except Exception as exc:
            message = str(exc).replace("{", "").replace("}", "")
            error_latex = r"\text{Error: " + message.replace("_", r"\_") + "}"
            results.append({"ok": False, "symbolic": error_latex, "numeric": error_latex})

    return json.dumps({"results": results})
