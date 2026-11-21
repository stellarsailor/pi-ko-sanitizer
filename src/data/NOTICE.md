# Supplemental dictionary data

The sanitizer source code is MIT licensed. Its bundled word tables are derived data, licensed separately as described below. Only written word pairs are included, not definitions, usage examples, media, prompts, or model output.

## Hanja and Hangul word pairs

`hanja.tsv.gz` is a normalized, deduplicated subset of the [libhangul Hanja dictionary](https://github.com/libhangul/libhangul/blob/23d2cd9d10d516d523d60c562dbcc7ea08139a09/data/hanja/hanja.txt). Descriptions have been removed. The data file carries the following license, distinct from the library code's license:

Copyright (c) 2005,2006 Choe Hwanjin  
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the author nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.

## Japanese and Korean word pairs

`japanese-headings.tsv.gz` is adapted from the [Korean Basic Dictionary](https://krdict.korean.go.kr/) provided by the National Institute of Korean Language, November 2026 JSON bulk release. It reverses the written Japanese equivalents of Korean nouns and keeps the top-ranked Korean headword when the ranking has no tie. Kana that only spell a bracketed kanji word, and forms that also translate a Korean adverb, are excluded so that a reading such as 요약's is not applied to an unrelated word. It is distributed under [Creative Commons Attribution-ShareAlike 2.0 Korea](https://creativecommons.org/licenses/by-sa/2.0/kr/). This file does not contain quoted examples or third-party multimedia. See the dictionary's [copyright policy](https://krdict.korean.go.kr/kor/kboardPolicy/copyRightTermsInfo) and [reuse guidance](https://krdict.korean.go.kr/kor/help/helpList).

## Rebuild

Download the pinned Hanja text linked above and the November 2026 snapshot of the [Korean Basic Dictionary JSON bulk export](https://krdict.korean.go.kr/download/downloadPopup), then run:

```bash
python3 scripts/build-lexicons.py /path/to/hanja.txt /path/to/krdict.zip
```

The script verifies both input hashes. A newer source snapshot requires verifying its terms and updating the documented snapshot and hash.
