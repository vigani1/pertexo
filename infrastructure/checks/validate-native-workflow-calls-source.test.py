"""Offline regression tests; no SQL is installed or executed."""

import importlib.util
import sys
from pathlib import Path
import unittest
from pglast import ast, parse_sql
from pglast.stream import RawStream

sys.dont_write_bytecode = True

module_path = Path(__file__).with_name("validate-native-workflow-calls-source.py")
spec = importlib.util.spec_from_file_location("native_source_parser", module_path)
parser = importlib.util.module_from_spec(spec)
spec.loader.exec_module(parser)
project = Path(__file__).resolve().parents[2]
source = (project / "packages/database/src/execution/workflow-calls/0137-native-execution-values.candidate.sql").read_text()


class NativeSourceGrammarTests(unittest.TestCase):
    def test_actual_published_constraint_preserves_registered_retained_predicate(self):
        registered = (project / "packages/database/migrations/0012_workflow_authoring.sql").read_text()
        registered = parser.re.sub(r"\{\{([a-z_]+)\}\}", lambda match: "pertexo_" + match[1], registered)
        old = next(element.raw_expr for statement in parse_sql(registered)
                   if isinstance(statement.stmt, ast.CreateStmt) and statement.stmt.relation.relname == "workflow_versions"
                   for element in statement.stmt.tableElts if isinstance(element, ast.Constraint)
                   and element.conname == "workflow_versions_schema_version_supported")
        expanded = parser.re.sub(r"\{\{([a-z_]+)\}\}", lambda match: "pertexo_" + match[1], source)
        new = next(command.def_.raw_expr for statement in parse_sql(expanded)
                   if isinstance(statement.stmt, ast.AlterTableStmt) and statement.stmt.relation.relname == "workflow_versions"
                   for command in statement.stmt.cmds if isinstance(command.def_, ast.Constraint)
                   and command.def_.conname == "workflow_versions_schema_version_supported")
        # CHECK uses explicit IS TRUE; the first OR arm is precisely retained schema=1.
        retained = new.arg.args[0]
        self.assertEqual(RawStream()(retained), RawStream()(old))
        native = RawStream()(new.arg.args[1])
        self.assertIn("schema_version = 2", native)
        self.assertIn("executable_schema_version = 3", native)
        self.assertIn("graph_json -> 'schemaVersion'", native)
        self.assertIn("executable_json -> 'schemaVersion'", native)
        self.assertIn("IS NOT DISTINCT FROM", native)

    def test_complete_candidate_and_procedural_bodies_parse_without_execution(self):
        statements, bodies = parser.validate(source)
        self.assertGreater(statements, 190)
        self.assertEqual(bodies, 59)

    def test_rejects_truncated_checksum_condition(self):
        valid = "OR (v_version.checksum ~ '^wf:v3:sha256:[0-9a-f]{64}$') IS NOT TRUE THEN"
        self.assertIn(valid, source)
        broken = source.replace(valid, "OR (v_version.checksum ~ '^wf:v3:sha256:[0-9a-f]{64}", 1)
        with self.assertRaises(Exception):
            parser.validate(broken)

    def test_rejects_free_standing_duplicated_procedural_tail(self):
        marker = "-- Private write ordering wraps"
        self.assertIn(marker, source)
        broken = source.replace(marker, ") IS NOT TRUE THEN RAISE EXCEPTION 'duplicated tail'; END IF;\n" + marker, 1)
        with self.assertRaises(Exception):
            parser.validate(broken)

    def test_checks_plpgsql_expression_grammar_not_only_outer_create_function(self):
        valid = "IS DISTINCT FROM (CASE WHEN v_type='integer' THEN 'number' ELSE v_type END) THEN"
        self.assertIn(valid, source)
        broken = source.replace(valid, "IS DISTINCT FROM CASE WHEN v_type='integer' THEN 'number' ELSE v_type END THEN", 1)
        with self.assertRaises(Exception):
            parser.validate(broken)


if __name__ == "__main__":
    unittest.main()
