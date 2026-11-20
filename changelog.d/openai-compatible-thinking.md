---
section: Added
---
`OPENAI_COMPATIBLE_THINKING=off` (or `on`) sends
`chat_template_kwargs.enable_thinking` to an OpenAI-compatible server, so a
hybrid reasoning model (Qwen-style template on llama.cpp, vLLM or SGLang) no
longer spends the short set-parse budget on thinking and gets cut off.
