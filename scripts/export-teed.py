"""Rebuild the bundled TEED ONNX model from pinned upstream MIT sources.

Build-only dependencies: torch==2.10.0 (CPU), onnx==1.20.1.
The application itself does not need Python or PyTorch.
"""
import hashlib
import json
from pathlib import Path
import sys
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
REVISION = "40fa4b1391dc6424f88989d0ca75d5b592c8681d"
BASE = f"https://raw.githubusercontent.com/xavysp/TEED/{REVISION}/"
CACHE = ROOT / ".cache" / "teed-upstream"
OUT = ROOT / "public" / "models"
paths = ["ted.py", "utils/AF/Fsmish.py", "utils/AF/Xsmish.py", "LICENSE", "checkpoints/BIPED/7/7_model.pth"]
hashes = {}
for name in paths:
    target = CACHE / name
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        urllib.request.urlretrieve(BASE + name, target)
    hashes[name] = hashlib.sha256(target.read_bytes()).hexdigest()

# This import is unused by the network; avoid pulling visualization dependencies.
definition = (CACHE / "ted.py").read_text(encoding="utf-8")
definition = definition.replace("from utils.img_processing import count_parameters", "# unused diagnostic import removed for export")
(CACHE / "ted_export.py").write_text(definition, encoding="utf-8")
sys.path.insert(0, str(CACHE))
import torch
import onnx
from ted_export import TED

class FusedEdges(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.net = TED()

    def forward(self, image):
        return torch.sigmoid(self.net(image)[-1])

torch.set_num_threads(2)
torch.manual_seed(0)
model = FusedEdges().eval()
model.net.load_state_dict(torch.load(CACHE / paths[-1], map_location="cpu", weights_only=True))
OUT.mkdir(parents=True, exist_ok=True)
output = OUT / "teed-512.onnx"
dummy = torch.zeros(1, 3, 512, 512)
torch.onnx.export(model, dummy, output, input_names=["image"], output_names=["edges"], opset_version=17, dynamo=False)
onnx.checker.check_model(str(output))
(OUT / "TEED-LICENSE.txt").write_bytes((CACHE / "LICENSE").read_bytes())
card = {
    "name": "TEED BIPED epoch 7", "upstream": "https://github.com/xavysp/TEED", "revision": REVISION,
    "license": "MIT", "input": {"shape": [1, 3, 512, 512], "layout": "BGR NCHW", "mean": [103.939, 116.779, 123.68], "scale": 1},
    "output": {"name": "edges", "shape": [1, 1, 512, 512], "range": [0, 1], "sigmoidIncluded": True},
    "opset": 17, "sha256": hashlib.sha256(output.read_bytes()).hexdigest(), "sourceSha256": hashes,
    "modifications": "Removed unused diagnostic import; exported only fused output with sigmoid; fixed 512x512 input. No retraining.",
}
(OUT / "teed-model.json").write_text(json.dumps(card, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"path": str(output), "bytes": output.stat().st_size, "sha256": card["sha256"]}))
