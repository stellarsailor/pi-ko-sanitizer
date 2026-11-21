# Changelog

## 0.1.2

- Use synthetic test inputs rather than recorded prompts and model replies.
- Remove corpus-dependent development scripts and document the fixture policy.
- The sanitizer's runtime behavior is unchanged.

## 0.1.1

- Read short kana tails attached to Hangul words while preserving Japanese particles and protected text.
- Limit experimental model correction to the first eligible text part of a reply. Check substitutions at each occurrence.
- Publish English and Korean guides.

## 0.1.0

- Add a local dictionary pass and opt-in model correction for mixed-language Korean replies.
- Preserve protected text and report uncertain spans without deleting them.
