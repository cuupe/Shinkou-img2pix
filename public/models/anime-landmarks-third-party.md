# Anime landmark model source notices

The bundled pretrained HRNetV2-W18 weights and the upstream wrapper are from
[hysts/anime-face-detector](https://github.com/hysts/anime-face-detector),
Copyright (c) 2021 hysts, MIT License. See ANIME-LANDMARKS-LICENSE.txt.

The network definition used when exporting ONNX contains upstream adaptations of
MMPose v0.29.0 HRNet, ResNet blocks and heatmap head code, and minimal MMCV v1.7.0
building blocks. These definitions are licensed under Apache License 2.0 by
OpenMMLab. See MMPose-LICENSE.txt and the pinned upstream repository for the
per-file copyright headers and modification notices. No MMDetection face
network or its weights are included in this application.

The model was exported for inference without retraining or changing pretrained
parameters. The export script, source commit and weight checksums are recorded
in anime-landmarks-model.json. Image normalization and heatmap decoding run in
this application's own TypeScript implementation; its decoder uses quarter-pixel
refinement rather than the upstream DARK/flip-test pipeline.

The independent face-box stage uses nagadomi's MIT-licensed LBP cascade,
Copyright (C) 2011 nagadomi@nurs.or.jp. See ANIME-LBP-LICENSE.txt.
