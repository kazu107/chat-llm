FROM vllm/vllm-openai:latest

# Some LFM models require Transformers 5.x (dev) for the tokenizer backend.
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
RUN uv pip install --system "git+https://github.com/huggingface/transformers.git" "tokenizers>=0.22.0"
RUN python3 - <<'PY'
from pathlib import Path

replacement = '\n'.join([
    'try:',
    '    from transformers.configuration_utils import ALLOWED_LAYER_TYPES',
    'except ImportError:',
    '    ALLOWED_LAYER_TYPES = (',
    '        \"full_attention\",',
    '        \"sliding_attention\",',
    '        \"chunked_attention\",',
    '        \"linear_attention\",',
    '    )',
])

targets = [
    Path('/usr/local/lib/python3.12/dist-packages/vllm/config/model.py'),
    Path('/usr/local/lib/python3.12/dist-packages/vllm/transformers_utils/config.py'),
    Path('/usr/local/lib/python3.12/dist-packages/vllm/model_executor/models/transformers/utils.py'),
]

needle = 'from transformers.configuration_utils import ALLOWED_LAYER_TYPES'
for path in targets:
    src = path.read_text()
    if needle in src:
        path.write_text(src.replace(needle, replacement))
PY

RUN python3 - <<'PY'
from pathlib import Path

path = Path('/usr/local/lib/python3.12/dist-packages/vllm/model_executor/models/transformers/multimodal.py')
src = path.read_text()

if 'force_max_tiles' not in src:
    helper = '''


def _get_num_multimodal_tokens(
    processor,
    image_sizes=None,
    *,
    force_max_tiles=False,
    **mm_processor_kwargs,
):
    if hasattr(processor, "_get_num_multimodal_tokens"):
        return processor._get_num_multimodal_tokens(
            image_sizes=image_sizes, **mm_processor_kwargs
        )

    if image_sizes is None:
        raise ValueError("image_sizes is required for multimodal token counting")

    if not hasattr(processor, "_get_image_num_tokens"):
        raise AttributeError(
            "Processor does not support multimodal token counting."
        )

    image_processor = getattr(processor, "image_processor", None)
    if image_processor is None:
        raise AttributeError(
            "Processor missing image_processor for multimodal token counting."
        )

    def get_kw(name, default_attr=None):
        if name in mm_processor_kwargs:
            return mm_processor_kwargs[name]
        attr = default_attr or name
        return getattr(image_processor, attr)

    downsample_factor = get_kw("downsample_factor")
    encoder_patch_size = get_kw("encoder_patch_size")
    tile_size = get_kw("tile_size")
    min_tiles = get_kw("min_tiles")
    max_tiles = get_kw("max_tiles")
    use_thumbnail = get_kw("use_thumbnail")
    min_image_tokens = get_kw("min_image_tokens")
    max_image_tokens = get_kw("max_image_tokens")
    max_pixels_tolerance = get_kw("max_pixels_tolerance")
    do_image_splitting = mm_processor_kwargs.get(
        "do_image_splitting",
        getattr(image_processor, "do_image_splitting", True),
    )

    if not do_image_splitting:
        min_tiles = 1
        max_tiles = 1

    num_image_tokens = []
    num_image_patches = []

    for size in image_sizes:
        height, width = int(size[0]), int(size[1])
        if hasattr(image_processor, "smart_resize"):
            new_width, new_height = image_processor.smart_resize(
                height=height,
                width=width,
                downsample_factor=downsample_factor,
                min_image_tokens=min_image_tokens,
                max_image_tokens=max_image_tokens,
                encoder_patch_size=encoder_patch_size,
            )
        else:
            new_height, new_width = height, width

        num_tiles = 1
        if do_image_splitting:
            if force_max_tiles:
                num_tiles = max_tiles
            else:
                is_large = False
                if hasattr(image_processor, "_is_image_too_large"):
                    is_large = image_processor._is_image_too_large(
                        height=height,
                        width=width,
                        max_image_tokens=max_image_tokens,
                        encoder_patch_size=encoder_patch_size,
                        downsample_factor=downsample_factor,
                        max_pixels_tolerance=max_pixels_tolerance,
                    )
                if is_large and hasattr(image_processor, "_get_grid_layout"):
                    grid_width, grid_height, *_ = image_processor._get_grid_layout(
                        height=height,
                        width=width,
                        min_tiles=min_tiles,
                        max_tiles=max_tiles,
                        tile_size=tile_size,
                    )
                    num_tiles = grid_width * grid_height

        tokens_per_tile, tokens_for_image = processor._get_image_num_tokens(
            [new_height, new_width], **mm_processor_kwargs
        )
        if num_tiles > 1:
            tokens = num_tiles * tokens_per_tile
            if use_thumbnail:
                tokens += tokens_for_image
        else:
            tokens = tokens_for_image
        num_image_tokens.append(int(tokens))

        patches_per_tile = (tile_size // encoder_patch_size) ** 2
        patches_for_image = (new_height // encoder_patch_size) * (
            new_width // encoder_patch_size
        )
        if num_tiles > 1:
            patches = num_tiles * patches_per_tile
            if use_thumbnail:
                patches += patches_for_image
        else:
            patches = patches_for_image
        num_image_patches.append(int(patches))

    return {
        "num_image_tokens": num_image_tokens,
        "num_image_patches": num_image_patches,
    }
'''

    needle = '}\n\n\nclass MultiModalProcessingInfo'
    if needle in src:
        src = src.replace(needle, '}\n' + helper + '\n\nclass MultiModalProcessingInfo', 1)
    else:
        raise RuntimeError('Failed to find insertion point for multimodal helper')

    old = 'mm_tokens = processor._get_num_multimodal_tokens(\n            image_sizes=([height, width],), **mm_processor_kwargs\n        )'
    new = 'mm_tokens = _get_num_multimodal_tokens(\n            processor,\n            image_sizes=([height, width],),\n            force_max_tiles=True,\n            **mm_processor_kwargs,\n        )'
    if old in src:
        src = src.replace(old, new, 1)
    else:
        raise RuntimeError('Failed to patch get_max_image_tokens call')

    old = 'mm_tokens_per_modality = hf_processor._get_num_multimodal_tokens(\n            image_sizes=image_sizes, **mm_processor_kwargs\n        )'
    new = 'mm_tokens_per_modality = _get_num_multimodal_tokens(\n            hf_processor,\n            image_sizes=image_sizes,\n            **mm_processor_kwargs,\n        )'
    if old in src:
        src = src.replace(old, new, 1)
    else:
        raise RuntimeError('Failed to patch apply call')

    old = 'token_type_key = (\n            \"mm_token_type_ids\"\n            if \"mm_token_type_ids\" in processed_data\n            else \"token_type_ids\"\n        )\n        mm_token_type_ids = processed_data.pop(token_type_key)\n'
    new = 'token_type_key = None\n        if \"mm_token_type_ids\" in processed_data:\n            token_type_key = \"mm_token_type_ids\"\n        elif \"token_type_ids\" in processed_data:\n            token_type_key = \"token_type_ids\"\n\n        if token_type_key is None:\n            image_token_id = getattr(hf_processor, \"image_token_id\", None)\n            if image_token_id is None:\n                raise KeyError(\"token_type_ids\")\n            mm_token_type_ids = torch.tensor(\n                [[1 if token_id == image_token_id else 0 for token_id in prompt_ids]]\n            )\n        else:\n            mm_token_type_ids = processed_data.pop(token_type_key)\n'
    if old in src:
        src = src.replace(old, new, 1)
    else:
        raise RuntimeError('Failed to patch token_type_ids handling')

    old = '            if isinstance(vision_embeddings, torch.Tensor):\n                if vision_embeddings.ndim == 2:\n                    vision_embeddings = vision_embeddings.unsqueeze(0)\n\n                # Embeddings have to be 2D tensors of length `num_images`\n                # but transformers returns concat tensors if each patch\n                # is of different size. We split it back to make vLLM happy\n                vision_embeddings = torch.split(\n                    vision_embeddings, num_image_patches.flatten().tolist()\n                )\n                vision_embeddings = [\n                    embed.flatten(start_dim=0, end_dim=-2)\n                    for embed in vision_embeddings\n                ]\n\n            return vision_embeddings\n'
    new = '            if isinstance(vision_embeddings, torch.Tensor):\n                if vision_embeddings.ndim == 2:\n                    vision_embeddings = vision_embeddings.unsqueeze(0)\n\n                # Embeddings have to be 2D tensors of length `num_images`\n                # but transformers returns concat tensors if each patch\n                # is of different size. We split it back to make vLLM happy\n                vision_embeddings = torch.split(\n                    vision_embeddings, num_image_patches.flatten().tolist()\n                )\n                vision_embeddings = [\n                    embed.flatten(start_dim=0, end_dim=-2)\n                    for embed in vision_embeddings\n                ]\n            elif isinstance(vision_embeddings, (list, tuple)):\n                expected_items = len(num_image_patches)\n                if expected_items == 1 and len(vision_embeddings) > 1:\n                    vision_embeddings = [\n                        torch.cat(list(vision_embeddings), dim=0)\n                    ]\n\n            return vision_embeddings\n'
    if old in src:
        src = src.replace(old, new, 1)
    else:
        raise RuntimeError('Failed to patch embed_multimodal handling')

    path.write_text(src)
PY
