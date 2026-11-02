import base64
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image
from runner import build_command, prepare_image, restore


def encoded_image(size=(64, 96)):
    data = io.BytesIO()
    Image.new('RGB', size, 'blue').save(data, format='PNG')
    return base64.b64encode(data.getvalue()).decode()


class RunnerTests(unittest.TestCase):
    def test_input_conversion_and_bounds(self):
        image = prepare_image(encoded_image(), 1)
        self.assertEqual(image.mode, 'RGB')
        self.assertEqual(image.size, (64, 96))
        for data, scale in [(encoded_image((2049, 40)), 1), (encoded_image((100, 2000)), 2),
                            (base64.b64encode(b'no image').decode(), 1), (encoded_image(), 4)]:
            with self.assertRaises(Exception):
                prepare_image(data, scale)

    def test_cli_parameters_are_explicit_and_never_shell_interpolated(self):
        command = build_command(Path('/tmp/upstream'), Path('input'), Path('output'), 'F', 2, 1234)
        self.assertIn('--no_llava', command)
        self.assertIn('--use_tile_vae', command)
        self.assertEqual(command[command.index('--SUPIR_sign') + 1], 'F')
        with self.assertRaises(ValueError):
            build_command(Path('.'), Path('.'), Path('.'), 'F;rm', 2, 0)

    def test_runner_reads_expected_upstream_output_and_returns_jpeg(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            (repo / 'test.py').touch()
            def fake_inference(command, **kwargs):
                self.assertTrue(kwargs['check'])
                self.assertEqual(kwargs['timeout'], 900)
                output = Path(command[command.index('--save_dir') + 1])
                Image.new('RGB', (128, 192), 'blue').save(output / 'card_0.png')
            job = dict(input_base64=encoded_image(), model='F', scale=2, seed=1234)
            with patch.dict(os.environ, SUPIR_REPO=str(repo)):
                result = base64.b64decode(restore(job, execute=fake_inference))
            with Image.open(io.BytesIO(result)) as image:
                self.assertEqual(image.format, 'JPEG')
                self.assertEqual(image.size, (128, 192))


if __name__ == '__main__':
    unittest.main()
