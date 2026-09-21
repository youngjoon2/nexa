# Third-party components and models

Nexa installs the following artifacts separately from GitHub. Exact artifact URLs, versions, SHA256 values, and model provenance are recorded in [`config/artifacts.json`](config/artifacts.json); local installation receipts are in `.runtime/installed.json`. Downloaded artifacts and weights are not committed to this repository. Upstream licenses and any notices shipped in archives remain in the installed folders.

| Component | Pinned version | License / upstream |
| --- | --- | --- |
| Bun | 1.4.2 | [MIT; bundled dependencies have their own notices](https://github.com/oven-sh/bun/blob/bun-v1.4.2/LICENSE.md) |
| Hono | 4.13.8 | [MIT](https://github.com/honojs/hono/blob/v4.13.8/LICENSE), archive includes LICENSE |
| llama.cpp | b11065 | [MIT](https://github.com/ggml-org/llama.cpp/blob/b11065/LICENSE), plus bundled LLVM OpenMP and other runtime notices |
| NVIDIA CUDA redistributable DLLs | 12.4, llama b11065 release | [NVIDIA CUDA Toolkit license](https://docs.nvidia.com/cuda/eula/index.html); shipped separately in the upstream llama release |
| Qdrant | 1.19.1 | [Apache-2.0](https://github.com/qdrant/qdrant/blob/v1.19.1/LICENSE) |
| Poppler Windows build | 26.09.0-0 | [Upstream Windows distribution](https://github.com/oschwartz10612/poppler-windows), Poppler is GPL-2.0-or-later; included libraries retain their licenses. PDF extraction runs as a separate executable. |
| Pandoc Windows build | 3.11 | [GPL-2.0-or-later with the component exceptions listed in upstream COPYRIGHT](https://github.com/jgm/pandoc/blob/3.11/COPYRIGHT); [official release](https://github.com/jgm/pandoc/releases/tag/3.11). DOCX extraction runs as a separate executable. Installed notices: `.runtime/pandoc/COPYRIGHT.txt` and `COPYING.rtf`. |
| MinGit / Git for Windows | 2.55.0.5 | [Git GPL version 2, except where an individual file states otherwise](https://github.com/git-for-windows/git/blob/v2.55.0.windows.5/COPYING); [official release](https://github.com/git-for-windows/git/releases/tag/v2.55.0.windows.5). Installed Git license: `.runtime/git/LICENSE.txt`; OpenSSH, Git Credential Manager and bundled libraries retain their own notices under the distribution's `mingw64` and `usr` directories. |
| Tree-sitter / web-tree-sitter | 0.27.0 | [MIT](https://github.com/tree-sitter/tree-sitter/blob/v0.27.0/LICENSE) |
| C and C++ grammar WASM | website commit `36838f4e0eb5e8a81355faf051ce7b1cbd166d9f` | [tree-sitter-c MIT](https://github.com/tree-sitter/tree-sitter-c/blob/master/LICENSE), [tree-sitter-cpp MIT](https://github.com/tree-sitter/tree-sitter-cpp/blob/master/LICENSE); [published WASM snapshot](https://github.com/tree-sitter/tree-sitter.github.io/tree/36838f4e0eb5e8a81355faf051ce7b1cbd166d9f) |

## Generation model

Qwen3.5-4B Q4_K_M is downloaded from [xiaocongyu66/qwen35-4b-gguf release v1](https://github.com/xiaocongyu66/qwen35-4b-gguf/releases/tag/v1), a third-party mirror that reports an Unsloth GGUF source. The two numbered parts and reconstructed model are checked against the mirror's published hashes. The [Qwen3.5 upstream repository](https://github.com/QwenLM/Qwen3.5) identifies the Qwen3.5 series as Apache-2.0. Matching mirror hashes verifies byte integrity, not independent authentication of the upstream conversion, training provenance, or redistribution authorization.

## Embedding model

EmbeddingGemma-300M Q8_0 is downloaded from [dgriffin831/embeddinggemma-gguf-mirror](https://github.com/dgriffin831/embeddinggemma-gguf-mirror) at commit `59137e0198aa9e41671fd804c5a6efd9464737a0`. The mirror reports ggml-org's upstream conversion revision `0f741b5a6585bd53aeb15cd1372c56f2a0f65e12`; this information is retained as publisher provenance and was not independently authenticated.

EmbeddingGemma uses the custom [Gemma Terms of Use](https://ai.google.dev/gemma/terms) and [Gemma Prohibited Use Policy](https://ai.google.dev/gemma/prohibited_use_policy), not a permissive MIT/Apache model license. Model use, derivatives, and redistribution remain subject to those terms. The license links are references; the installer never downloads weights from Google or Hugging Face. If redistributing an assembled Nexa bundle or these model files, include the applicable upstream license and required notices with that distribution.

The initial local feasibility check covered six synthetic documents. It is not a comprehensive accuracy, security, licensing, or production-load certification.
