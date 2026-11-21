# Changelog

## 0.1.3 - 2026-11-21

- Restore verified mixed Hanja–Hangul words with word-initial and batchim-sensitive pronunciation rules.
- Replace the hand-written Hanja list with a 236k-word table, so mixed Hanja–Hangul words and Hanja words with Korean particles are read across the dictionary instead of a fixed list.
- Replace the fixed Japanese heading list with a 7.6k noun-pair table built from dictionary equivalents. Ties, kanji readings used as kana, and words that also translate a Korean adverb are left out.
- Keep Hanja word readings out of the translated-passage cap, so a reply quoting many Hanja words keeps its corrections.
- Read quoted Hanja terms in Korean prose, while a Hanja gloss such as 개항(開港) and a Japanese quotation stay untouched.
- Drop an oversized provider answer before parsing, and remove quadratic regex scans that a long Han paragraph could trigger.
- Read a bare Han word glued to a Hangul noun (파일改名) from the word table, while a spaced word still waits for context.
- Protect code spans with matching backtick runs and fenced blocks that extend to the end of a reply.
- Preserve HTTP and HTTPS URLs with mixed-case schemes or balanced parentheses in both correction modes.

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
