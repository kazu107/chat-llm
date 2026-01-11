FROM vllm/vllm-openai:latest

# 例: model の config.json が transformers_version=4.57.3 を要求する場合に合わせる
# （必要なら git+https://github.com/huggingface/transformers.git に変える）
RUN uv pip install --system "transformers==4.57.3"
