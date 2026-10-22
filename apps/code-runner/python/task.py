"""Trusted bootstrap for one task; inherited kernel fences provide isolation."""
import builtins
import ast
import importlib
import json
import math
import os
import sys
import traceback


def main():
    if sys.version_info[:3] != (3, 15, 1):
        raise RuntimeError("Code requires CPython 3.15.1")
    boot = json.loads(os.environ["CODE_CHILD_BOOT"])
    for name in boot["pythonPackages"]:
        if name.split(".")[0] in sys.stdlib_module_names:
            raise RuntimeError("Extra Python packages must be installed third-party packages, not standard-library modules")
    modules = frozenset(boot["pythonModules"] + boot["pythonPackages"])
    # Dependencies initialize before user imports are restricted. They do not
    # grant callers permission to import those dependencies themselves.
    for name in modules:
        importlib.import_module(name)
    importlib.import_module("html.parser")
    importlib.import_module("collections.abc")
    native_import = builtins.__import__
    dumps, loads = json.dumps, json.loads
    write = os.write
    kind = type
    finite = math.isfinite
    primitive_types = (str, int, float, bool, type(None))
    budget = boot["json"]
    bounds = boot["console"]
    lines = 0
    logged_bytes = 0
    clipped = False

    class ModuleRefused(Exception):
        pass

    class InvalidOutput(Exception):
        pass

    def bounded_text(value, characters):
        # Protocol strings count UTF-16 code units, as the JavaScript owner does.
        return value.encode("utf-16-le", errors="replace")[:characters * 2].decode(
            "utf-16-le", errors="replace")

    def send(frame, descriptor=3):
        wire = (dumps(frame, ensure_ascii=False, allow_nan=False,
                      separators=(",", ":")) + "\n").encode("utf-8")
        while wire:
            count = write(descriptor, wire)
            wire = wire[count:]

    def allowed(name):
        return any(name == module or name.startswith(module + ".")
                   for module in modules)

    def user_import(name, globals=None, locals=None, fromlist=(), level=0):
        namespace = name == "urllib" and fromlist and all(
            item == "parse" for item in fromlist)
        if level or not (allowed(name) or namespace):
            raise ModuleRefused("Module '" + name[:214] + "' is not allowed in Python Code.")
        return native_import(name, globals, locals, fromlist, level)

    def log(*values, sep=" ", end="\n", file=None, flush=False):
        nonlocal lines, logged_bytes, clipped
        if file is not None:
            raise ModuleRefused("print() only writes to private Code diagnostics.")
        if clipped:
            return
        message = sep.join(str(value) for value in values)
        retained = bounded_text(message, bounds["characters"])
        shortened = retained != message
        message = retained
        size = len(message.encode("utf-8", errors="replace"))
        if lines >= bounds["lines"] or logged_bytes + size > bounds["bytes"]:
            clipped = True
            send({"truncated": True}, 1)
            return
        lines += 1
        logged_bytes += size
        send({"level": "log", "message": message}, 1)
        if shortened:
            send({"truncated": True}, 1)

    def encode_output(value):
        seen = set()
        members = 0

        def visit(item, depth):
            nonlocal members
            item_type = kind(item)
            if item_type in primitive_types:
                if item_type is float and not finite(item):
                    raise InvalidOutput("Return finite JSON numbers; NaN and Infinity are not JSON.")
                if item_type is int and abs(item) > 9_007_199_254_740_991:
                    raise InvalidOutput("Return integers within the exact JSON number range, or convert them to text.")
                return
            if item_type not in (dict, list):
                raise InvalidOutput("Return only JSON dictionaries, lists, strings, numbers, booleans or None.")
            if depth > budget["depth"] or id(item) in seen:
                raise InvalidOutput("Output exceeds JSON depth bounds or repeats an object reference.")
            seen.add(id(item))
            members += len(item)
            if members > budget["members"]:
                raise InvalidOutput("Output has too many JSON members. Return less data.")
            if item_type is dict:
                for key, child in item.items():
                    if kind(key) is not str:
                        raise InvalidOutput("JSON dictionary keys must be strings.")
                    visit(child, depth + 1)
            else:
                for child in item:
                    visit(child, depth + 1)
        visit(value, 1)
        encoded = dumps(value, ensure_ascii=False, allow_nan=False,
                        separators=(",", ":"))
        if len(encoded.encode("utf-8")) > budget["bytes"]:
            raise InvalidOutput("Output exceeds the JSON byte limit. Return less data.")

    send({"kind": "ready"})
    frame = sys.stdin.buffer.readline(boot["taskBytes"] + 1)
    if len(frame) > boot["taskBytes"] or not frame.endswith(b"\n"):
        raise RuntimeError("Code task exceeds the bounded transport envelope")
    task = loads(frame)
    body_lines = task["code"].replace("\r\n", "\n").replace("\r", "\n").split("\n")

    def column(line, offset, byte_offset=False):
        text = body_lines[line - 1] if 0 < line <= len(body_lines) else ""
        prefix = (text.encode("utf-8")[:offset].decode("utf-8", errors="ignore")
                  if byte_offset else text[:offset])
        return len(prefix.encode("utf-16-le")) // 2 + 1

    phase = "compile"
    try:
        tree = ast.parse("\n".join(body_lines), "pertexo-code.py")
        if not tree.body:
            raise SyntaxError("Enter a Python function body.", ("pertexo-code.py", 1, 1, body_lines[0]))
        # Indenting source would also indent multiline string contents. Wrap
        # the parsed statements instead, retaining their original coordinates.
        function = ast.FunctionDef(
            name="pertexo_code",
            args=ast.arguments(posonlyargs=[], args=[ast.arg(arg="input"), ast.arg(arg="_vars")],
                               vararg=None, kwonlyargs=[], kw_defaults=[], kwarg=None, defaults=[]),
            body=tree.body, decorator_list=[], type_params=[],
            returns=None, type_comment=None,
            lineno=1, col_offset=0, end_lineno=len(body_lines),
            end_col_offset=len(body_lines[-1].encode("utf-8")))
        tree.body = [function]
        compiled = compile(ast.fix_missing_locations(tree), "pertexo-code.py", "exec")
        user_builtins = dict(vars(builtins))
        for name in ("open", "exec", "eval", "compile", "breakpoint", "help", "exit", "quit"):
            user_builtins.pop(name, None)
        user_builtins["__import__"] = user_import
        user_builtins["print"] = log
        scope = {"__builtins__": user_builtins, "__name__": "pertexo_code"}
        exec(compiled, scope)
        phase = "execute"
        output = scope["pertexo_code"](task["input"], task["variables"])
        phase = "output"
        encode_output(output)
        send({"kind": "succeeded", "output": output,
              "diagnostics": {"logs": [], "truncated": False}})
    except BaseException as error:
        code = ("code.syntax_error" if phase == "compile" else
                "code.memory_limit" if isinstance(error, MemoryError) else
                "code.module_refused" if isinstance(error, ModuleRefused) else
                "code.output_invalid" if phase == "output" else
                "code.runtime_error")
        detail = {"message": bounded_text(error.msg if isinstance(error, SyntaxError) else str(error), 2048)}
        if phase == "compile" and isinstance(error, SyntaxError):
            detail["line"] = max(1, error.lineno or 1)
            detail["column"] = column(detail["line"], max(0, (error.offset or 1) - 1),
                                      byte_offset=error.text is None)
        else:
            for entry in traceback.extract_tb(error.__traceback__):
                if entry.filename == "pertexo-code.py":
                    detail["line"] = max(1, entry.lineno)
                    if entry.colno is not None:
                        detail["column"] = column(detail["line"], entry.colno, byte_offset=True)
        send({"kind": "failed", "code": code,
              "diagnostics": {"logs": [], "truncated": False, "error": detail}})


main()
