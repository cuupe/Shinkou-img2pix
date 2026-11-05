"""Export the pinned, MIT-licensed pretrained anime landmark network.

Build tool only. Requires torch==2.10.0, torchvision==0.25.0,
onnx==1.20.1, safetensors, numpy, opencv-python, huggingface_hub.
The desktop application needs none of these Python packages.
"""
import argparse
import hashlib
import pathlib
import subprocess
import sys

import torch

UPSTREAM_COMMIT = '98a9fb480fa04bdd96acbe4d98da191a898267f3'
WEIGHTS_SHA256 = 'e71271376406a743c01528a0460637fcc06e72aeeea583f85007cc72dc8b7a4a'

parser = argparse.ArgumentParser()
parser.add_argument('--upstream', type=pathlib.Path, required=True)
parser.add_argument('--weights', type=pathlib.Path, required=True)
parser.add_argument('--output', type=pathlib.Path, default=pathlib.Path('public/models/anime-landmarks.onnx'))
args = parser.parse_args()
commit = subprocess.check_output(['git', '-C', str(args.upstream), 'rev-parse', 'HEAD'], text=True).strip()
if commit != UPSTREAM_COMMIT:
    raise ValueError(f'Expected upstream commit {UPSTREAM_COMMIT}, received {commit}')
if hashlib.sha256(args.weights.read_bytes()).hexdigest() != WEIGHTS_SHA256:
    raise ValueError('Pretrained weights checksum mismatch')
sys.path.insert(0, str(args.upstream.resolve()))
from anime_face_detector._landmark import load_landmark_model


class Export(torch.nn.Module):
    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, image):
        return self.net.keypoint_head(self.net.backbone(image))


torch.set_num_threads(8)
model = Export(load_landmark_model(str(args.weights), device='cpu')).eval()
args.output.parent.mkdir(parents=True, exist_ok=True)
with torch.inference_mode():
    torch.onnx.export(model, torch.zeros(1, 3, 256, 256), str(args.output),
                      input_names=['image'], output_names=['heatmaps'],
                      opset_version=17, dynamo=False)
print(f'{args.output}: {args.output.stat().st_size} bytes')
print('SHA-256:', hashlib.sha256(args.output.read_bytes()).hexdigest())
