# pi-ko-sanitizer

**English** | [한국어](README-ko.md)

A [Pi](https://pi.dev) extension that replaces stray Chinese and Japanese words in otherwise Korean replies. This is post-processing, not a translator or a character blacklist.

```
문서에 使用된 용어를 확인하세요 → 문서에 사용된 용어를 확인하세요
표의 页面을 열어 주세요 → 표의 페이지를 열어 주세요
```

## Install

Requires Node.js 22.19.0 or newer.

```bash
pi install npm:pi-ko-sanitizer
pi -e npm:pi-ko-sanitizer
```

The extension runs on `message_end`. If you also use a Hanja-to-Hangul converter, load this extension first so it can match the original text.

## How it works

- **Dictionary correction is on by default.** It runs locally without a model call. It replaces only spans it can read in full, adjusts some Korean particles, and can read short kana tails attached to Hangul words.
- **Hanja words.** A bundled table of 236k Korean headwords with their Hanja spelling reads a word that mixes Han characters with its Hangul, and a Hanja word followed by a Korean particle. Initial-sound rules and the 렬/률 rule after a vowel or ㄴ are applied per word. A word with two surviving readings, a word without a Korean particle or Hangul, and a full Han sentence are left alone.
- **Japanese headings.** A bundled table of 7.6k Japanese to Korean noun pairs corrects a heading that introduces Korean text, including Markdown headings and bold labels. It needs a colon or a heading marker, and skips a Japanese body, a quotation, a code block, a tie between equally supported readings, a kana string that is only the reading of a kanji word, and a word that also translates a Korean adverb.
- The dictionary pass skips code, URLs, Japanese prose, Hanja glosses, and terms the user asked about. It leaves uncertain text in place instead of deleting it.
- **Model correction is experimental and off by default.** It asks the active model for substitutions for unreadable spans. It applies allowed substitutions to the original reply rather than regenerating the reply. A plausible but incorrect reading can still pass. A timeout or unusable result leaves the dictionary correction intact.

## Bundled data and licensing

The code is MIT. The two word tables are derived data under their own licenses, described in [`src/data/NOTICE.md`](src/data/NOTICE.md): Hanja readings from libhangul's data files, and Japanese–Korean pairs from the National Institute of Korean Language's Korean Basic Dictionary (CC BY-SA 2.0 KR). The tables hold written word pairs only. Definitions, example sentences, media, prompts and model output are not included. `scripts/build-lexicons.py` rebuilds them from pinned sources and checks their hashes.

## Configuration

| Variable | Default | Behavior |
|---|---|---|
| `PI_KO_SANITIZER_LLM` | off | Set to `1` to ask the active model about the first text part with eligible spans. |
| `PI_KO_SANITIZER_LLM_TIMEOUT` | `12000` | Model correction budget in milliseconds. |
| `PI_KO_SANITIZER_VERIFY` | off | Set to `1` to allow a second model call to check the proposed readings. It can reject good readings too. |
| `PI_KO_SANITIZER_OFF` | off | Set to `1` to disable correction and logging. |
| `PI_KO_SANITIZER_DEBUG` | off | Enable extra diagnostic logging. |
| `PI_KO_SANITIZER_LOG_TEXT` | off | Set to `1` to include leak text in the local diagnostic log. By default, findings are represented by digests. |

Use `/zh-ko` to see session counters and the local log path. Keep raw logging off for sensitive conversations. If you enable model correction with a remote provider, the prompt sends the entire selected text part to that provider, including text that the extension will not edit.

## Development

```bash
npm ci
npm run typecheck
npm test
```

Tests use synthetic examples and mock model responses. Do not commit conversation transcripts, search history, prompts captured from real sessions, or diagnostic logs. The dictionary core itself does not depend on Pi: see `src/sanitize.ts` and `src/rewrite.ts`. There is no separate npm entry point for the core.

## Hanja references

The mixed-script rules were implemented without external dependencies, with reference to [rockpicado/hanja](https://github.com/rockpicado/hanja) (MIT) and selected readings from [masoris/hanja_hangul](https://github.com/masoris/hanja_hangul) (CC0 1.0). Neither repository's full character table is bundled.

## License

MIT.
