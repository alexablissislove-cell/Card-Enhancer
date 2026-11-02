"""Queue contract tests without a database, CUDA or checkpoint downloads."""
import os
import unittest
from unittest.mock import MagicMock, patch

with patch.dict(os.environ, SUPIR_DATABASE_URL='test-only', SUPIR_QUEUE_NAMESPACE='preview'):
    import worker


class WorkerTests(unittest.TestCase):
    def test_claim_is_atomic_scoped_and_recoverable(self):
        conn = MagicMock()
        conn.execute.return_value.fetchone.return_value = None
        self.assertIsNone(worker.claim(conn))
        sql, values = conn.execute.call_args.args
        self.assertIn('FOR UPDATE SKIP LOCKED', sql)
        self.assertIn('lease_until < now()', sql)
        self.assertIn('attempts < 3', sql)
        self.assertEqual(values[0], 'preview')

    def test_completion_is_fenced_and_input_is_cleared(self):
        conn = MagicMock()
        job = {'id': 'job', 'lease_token': 'lease'}
        with patch.object(worker, 'connect') as connection, patch.object(worker, 'restore', return_value='output'):
            connection.return_value.__enter__.return_value = conn
            worker.process(job)
        sql, values = conn.execute.call_args.args
        self.assertIn('lease_token=%s', sql)
        self.assertIn('lease_until > now()', sql)
        self.assertIn("input_base64=''", sql)
        self.assertEqual(values, ('completed', 'output', None, 'job', 'lease'))

    def test_inference_errors_do_not_expose_local_details(self):
        conn = MagicMock()
        with patch.object(worker, 'connect') as connection, patch.object(worker, 'restore', side_effect=RuntimeError('private-path')):
            connection.return_value.__enter__.return_value = conn
            worker.process({'id': 'job', 'lease_token': 'lease'})
        _, values = conn.execute.call_args.args
        self.assertEqual(values[0], 'failed')
        self.assertNotIn('private-path', values[2])

    def test_maintenance_scopes_jobs_and_bounds_expired_retries(self):
        conn = MagicMock()
        worker.maintain(conn)
        statements = conn.execute.call_args_list
        self.assertIn('attempts>=3', statements[0].args[0])
        self.assertEqual(statements[0].args[1], ('preview',))
        self.assertIn("interval '24 hours'", statements[1].args[0])


if __name__ == '__main__':
    unittest.main()
