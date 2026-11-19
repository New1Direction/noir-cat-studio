# Third-party notices

Full, unmodified upstream license and notice texts are included in [`public/licenses/`](public/licenses/). Static builds copy these files to `/licenses/`; start with [`NOTICE.txt`](public/licenses/NOTICE.txt). [`manifest.json`](public/licenses/manifest.json) records package versions, the source of each text, and SHA-256 hashes of the copied files.

| Component | Version | Package license | Included text |
| --- | --- | --- | --- |
| Three.js | 0.181.2 | MIT | [License](public/licenses/three-LICENSE.txt) |
| MediaPipe Tasks Vision and Pose Landmarker Lite | SDK 1.2.2; model float16/1 | Apache-2.0 | [License and bundled notices](public/licenses/mediapipe-LICENSE.txt) |
| glTF Transform core | 4.5.1 | MIT | [License](public/licenses/gltf-transform-core-LICENSE.txt) |
| glTF Transform extensions | 4.5.1 | MIT | [License](public/licenses/gltf-transform-extensions-LICENSE.txt) |
| glTF Transform functions | 4.5.1 | MIT | [License](public/licenses/gltf-transform-functions-LICENSE.txt) |
| Khronos glTF Validator | 2.0.0-dev.3.10 | Apache-2.0 | [License](public/licenses/gltf-validator-LICENSE.txt), [notices](public/licenses/gltf-validator-NOTICES.txt) |

The browser dependency chain also includes the following packages. Their full upstream texts are included even where the production build removes unused code.

| Component | Version | Package license | Included text |
| --- | --- | --- | --- |
| property-graph | 4.1.0 | MIT | [License](public/licenses/property-graph-LICENSE.txt) |
| ktx-parse | 1.1.0 | MIT | [License](public/licenses/ktx-parse-LICENSE.txt) |
| ndarray | 1.1.1 | MIT | [License](public/licenses/ndarray-LICENSE.txt) |
| ndarray-lanczos | 0.3.0 | MIT | [License](public/licenses/ndarray-lanczos-LICENSE.txt) |
| ndarray-ops | 1.2.2 | MIT | [License](public/licenses/ndarray-ops-LICENSE.txt) |
| ndarray-pixels | 5.2.0 | MIT | [License](public/licenses/ndarray-pixels-LICENSE.txt) |
| cwise-compiler | 1.1.3 | MIT | [License](public/licenses/cwise-compiler-LICENSE.txt) |
| iota-array | 1.0.0 | MIT | [License](public/licenses/iota-array-LICENSE.txt) |
| is-buffer | 1.1.6 | MIT | [License](public/licenses/is-buffer-LICENSE.txt) |
| uniq | 1.0.1 | MIT | [License](public/licenses/uniq-LICENSE.txt) |

The type declarations for `@types/ndarray` 1.1.0 ([MIT text](public/licenses/types-ndarray-LICENSE.txt)) and the Vite 6.4.5 development/build tool ([license and dependency notices](public/licenses/vite-LICENSE.txt)) are included for source-package attribution. Node-only image-processing dependencies selected by `ndarray-pixels` are not shipped as browser assets; their notices remain in their installed packages.

MediaPipe's runtime and Google's Pose Landmarker Lite model are hosted under `public/mediapipe`. The original [`LICENSE.txt`](public/mediapipe/LICENSE.txt) remains beside those assets, and [`assets.json`](public/mediapipe/assets.json) records the pinned package, official model source, sizes, and hashes. The tracking worker blocks external requests, including SDK usage metrics. Selected videos and captured poses are processed locally and are not sent to a motion-capture service.

The stylesheet requests DM Sans and Manrope through Google Fonts; font files are not bundled in this repository. System fonts provide fallbacks.

The project's original source code, procedural 3D model, and animations are released under the [MIT license](LICENSE); a copy is served with the studio as [`project-LICENSE.txt`](public/licenses/project-LICENSE.txt). Third-party components retain their separate licenses above. The supplied `public/reference.png` is user-provided comparison material and is not covered by the project's MIT grant; its inclusion does not assert a separate license grant for that image. No character assets, game animation files, or music from other researched repositories are bundled.
