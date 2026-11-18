#!/usr/bin/env python3
"""汉字 → 假名 → mora → 元音。

为什么值得单独做一层
--------------------
1. **读音比汉字的正确率高**。ASR 选错汉字（「所業」→「処処」）多数时候是
   *同音/近音* 判断失误，读音本身是接近的。丢掉汉字只留假名，等于丢掉
   ASR 最容易出错的那一层。
2. **假名直接就是 mora**，而 mora 是日文口型的基本单位。
   一个 mora 对应一个元音口型，这是 P3 逐字口型的数据来源。
3. 日文是 **mora-timed** 语言，同一句里每个 mora 时长几乎相等，
   所以「行时长 ÷ mora 数」的均分估算天然比按字符数均分更准
   （汉字词「所業」两个字读 4 个 mora）。

用法：
    from kana import to_hiragana, split_mora, mora_vowel
    to_hiragana("最低の所業は")   -> 'さいていのしょぎょうは'
    split_mora("しょぎょう")      -> ['しょ', 'ぎょ', 'う']
"""

from __future__ import annotations

import re

# 需要和前面一个字符合并的小字
_SMALL = set("ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ")

# 元音归属表（平假名）
_VOWEL_ROWS = {
    "a": "あかさたなはまやらわがざだばぱぁゃゎ",
    "i": "いきしちにひみりぎじぢびぴぃ",
    "u": "うくすつぬふむゆるぐずづぶぷぅゅゔ",
    "e": "えけせてねへめれげぜでべぺぇ",
    "o": "おこそとのほもよろをごぞどぼぽぉょ",
}
_CHAR_VOWEL = {ch: vowel for vowel, chars in _VOWEL_ROWS.items() for ch in chars}

_KATAKANA_START = ord("ァ")
_KATAKANA_END = ord("ヶ")

# 日式英语词表：日语歌里的英文基本是按片假名读的，
# `give lead` 唱出来就是「ギリギリ」，`give me give love` 听起来像「ギンギラ」。
# 所以这里不做英文 G2P，直接当成片假名处理——反而更贴近实际发音。
# 未收录的词保持原样，后面会被 normalize_kana 丢掉（宁可没有，也不要读错）。
_EN_TO_KATA = {
    "a": "ア", "ah": "アー", "and": "アンド", "baby": "ベイビー", "be": "ビー",
    "crises": "クライシス", "do": "ドゥ", "down": "ダウン", "endless": "エンドレス",
    "face": "フェイス", "fake": "フェイク", "get": "ゲット", "gimme": "ギミー",
    "give": "ギブ", "go": "ゴー", "ha": "ハ", "i": "アイ", "it": "イット",
    "kiss": "キス", "lead": "リード", "let": "レット", "limited": "リミテッド",
    "love": "ラブ", "me": "ミー", "mess": "メス", "my": "マイ", "no": "ノー",
    "oh": "オー", "poker": "ポーカー", "shall": "シャル", "shy": "シャイ",
    "the": "ザ", "to": "トゥ", "up": "アップ", "want": "ワント", "we": "ウィー",
    "yeah": "イェア", "you": "ユー",
}

_EN_WORD = re.compile(r"[A-Za-z]+")

_converter = None


def _kakasi():
    global _converter
    if _converter is None:
        from pykakasi import kakasi

        _converter = kakasi()
    return _converter


def kata_to_hira(text: str) -> str:
    """片假名转平假名（逐字符平移，不涉及汉字）。"""
    out = []
    for ch in text:
        code = ord(ch)
        if _KATAKANA_START <= code <= _KATAKANA_END:
            out.append(chr(code - 0x60))
        else:
            out.append(ch)
    return "".join(out)


def translate_english(text: str) -> str:
    """把英文词按日式英语换成片假名；未收录的词原样保留。"""
    return _EN_WORD.sub(lambda m: _EN_TO_KATA.get(m.group(0).lower(), m.group(0)), text)


def to_hiragana(text: str) -> str:
    """英文词 → 片假名，汉字 + 片假名 → 全平假名。

    非日文字符（标点、数字、未收录的英文）保留原样。
    """
    result = _kakasi().convert(translate_english(text))
    return "".join(item.get("hira", item.get("orig", "")) for item in result)


def normalize_kana(text: str) -> str:
    """只保留假名，丢掉英文/数字/标点。

    比对和口型都只关心读音，混进来的拉丁字母会干扰字符级对齐。
    """
    return "".join(ch for ch in kata_to_hira(text) if "ぁ" <= ch <= "ゖ" or ch == "ー")


def split_mora(kana: str) -> list[str]:
    """切 mora。小字（ゃゅょ 等）并入前一个 mora，其余一字一 mora。"""
    morae: list[str] = []
    for ch in kana:
        if ch in _SMALL and morae:
            morae[-1] += ch
        else:
            morae.append(ch)
    return morae


def mora_vowel(mora: str) -> str:
    """mora 的元音：a/i/u/e/o/n/''（促音）。

    `-` 表示长音符，实际元音由调用方沿用前一个 mora。
    返回 `?` 表示无法识别的字符（通常是非假名残留）。

    注意拗音：`しょ` 读 sho，元音是 **o** 不是 i，
    要看末尾的小字（ゃ→a、ゅ→u、ょ→o），不能只看首字。
    """
    if not mora:
        return "?"
    head = mora[0]
    if head == "っ":
        return ""       # 促音：口型上是停顿/闭口
    if head == "ん":
        return "n"      # 拨音：闭口鼻音
    if head == "ー":
        return "-"      # 长音：沿用前一个元音
    if len(mora) > 1 and mora[-1] in _SMALL:
        return _CHAR_VOWEL.get(mora[-1], "?")
    return _CHAR_VOWEL.get(head, "?")


def line_morae(text: str) -> list[tuple[str, str]]:
    """一行歌词 → [(mora, 元音)]，已经处理好长音和无法识别的字符。"""
    return [(mora, vowel) for mora, vowel, _offset in line_morae_offsets(text)]


def line_morae_offsets(text: str) -> list[tuple[str, str, int]]:
    """一行歌词 → [(mora, 元音, 在假名串里的起始偏移)]。

    偏移量用于把 mora 对到 ASR 的词上：`offset` 是这一行
    `normalize_kana(to_hiragana(text))` 结果里的字符位置。
    """
    kana = normalize_kana(to_hiragana(text))
    morae: list[tuple[str, str, int]] = []

    for pos, ch in enumerate(kana):
        if ch in _SMALL and morae:
            mora, _vowel, start = morae[-1]
            merged = mora + ch
            morae[-1] = (merged, mora_vowel(merged), start)
            continue
        morae.append((ch, mora_vowel(ch), pos))

    result: list[tuple[str, str, int]] = []
    for mora, vowel, start in morae:
        if vowel == "-":
            # 长音沿用前一个 mora 的元音；没有前一个就当作 a
            vowel = result[-1][1] if result else "a"
            if vowel in ("", "n"):
                vowel = "a"
        elif vowel == "?":
            continue  # 非假名残留，不进 units
        result.append((mora, vowel, start))
    return result


def _self_test() -> None:
    samples = [
        ("最低の所業は 最愛の証拠", "さいていのしょぎょうは さいあいのしょうこ"),
        ("ラルラ レイレイ", "らるら れいれい"),
        ("I want.. ください", "I want.. ください"),
    ]
    for src, _expect in samples:
        hira = to_hiragana(src)
        morae = line_morae(src)
        print(f"{src}\n  → {hira}\n  → {' | '.join(f'{m}/{v}' for m, v in morae)}\n")


if __name__ == "__main__":
    _self_test()
