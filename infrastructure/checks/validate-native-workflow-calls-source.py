"""Offline syntax review only. Never connects to PostgreSQL or executes SQL.

Requires pglast (libpg_query), installed in a separate tooling environment.
The fresh candidate's installation-abort guard is parsed and never removed.
"""

import re
from pathlib import Path

from pglast import ast, parse_sql
from pglast.parser import parse_plpgsql_json
from pglast.stream import RawStream


def validate(source: str) -> tuple[int, int]:
    # Migration role template expansion is lexical, not SQL installation.
    sql = re.sub(r"\{\{([a-z_]+)\}\}", lambda match: "pertexo_" + match[1], source)
    statements = parse_sql(sql)
    bodies = 0
    for statement in statements:
        if not isinstance(statement.stmt, (ast.CreateFunctionStmt, ast.DoStmt)):
            continue
        definition = RawStream()(statement.stmt)
        # libpg_query has no application catalog for a composite RETURN type.
        # Resolve only this declared return type to record; its body is unchanged.
        definition = definition.replace(
            "RETURNS app.workflow_execution_value_provenance", "RETURNS record"
        )
        # Use the raw parser: pglast8.4's trigger datum JSON dump is malformed,
        # but parsing/checking PLpgSQL grammar succeeds before that dump.
        parse_plpgsql_json(definition)
        bodies += 1
    return len(statements), bodies


if __name__ == "__main__":
    project = Path(__file__).resolve().parents[2]
    candidate = project / "packages/database/src/execution/workflow-calls/0137-native-execution-values.candidate.sql"
    statements, bodies = validate(candidate.read_text())
    print(f"Offline PostgreSQL grammar: {statements} statements / {bodies} function-or-DO bodies PASS")
    print("No SQL execution, catalog resolution, authorization or lifecycle qualification.")
