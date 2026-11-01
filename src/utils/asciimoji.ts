export function getAsciimojiAtIndex(index: number): string {
  if (Number.isInteger(index) && index >= 0 && index < asciimojis.length) {
    return asciimojis[index]!;
  }
  return asciimojis[0]!;
}

const asciimojis = [
  "╰(｡◕ ‿ ◕｡)╯",
  "(ﾉ◕ヮ◕)ﾉ*:・ﾟ✧",
  "(*・‿・)ノ⌒*:･ﾟ✧",
  "(ﾉ☉ヮ⚆)ﾉ ⌒*:･ﾟ✧",
  "¯\\_( ͡° ͜ʖ ͡°)_/¯",
  "(=^･ｪ･^=))ﾉ彡☆",
  "⊂(◉‿◉)つ",
  "⊹╰(⌣ʟ⌣)╯⊹",
  "／人◕ ‿‿ ◕人＼",
  "( ´◔ ω◔`) ノシ",
  "ᕕ( ᐛ )ᕗ",
  "(づ｡◕‿‿◕｡)づ",
  "[̲̅$̲̅(̲̅ ͡° ͜ʖ ͡°̲̅)̲̅$̲̅]",
  "ʕ •́؈•̀)",
  "(◔_◔)",
  "୧༼ಠ益ಠ༽︻╦╤─",
  "(っ^з^)♪♬",
  "ʕっ•ᴥ•ʔっ",
  "( 0 _ 0 )",
  "( ˘ ³˘)ノ°ﾟº❍｡",
  "※\\(^o^)/※",
  "╭(ʘ̆~◞౪◟~ʘ̆)╮",
  "ԅ(≖‿≖ԅ)",
  "ヽ༼ຈل͜ຈ༽ﾉ",
  "(҂◡_◡) ᕤ",
  "ψ(｀∇´)ψ",
  "(✿◠‿◠)",
  "─=≡Σ((( つ◕ل͜◕)つ",
  "༼ つ ╹ ╹ ༽つ",
  "(´・ω・)っ由",
];

export const asciimojisCount = asciimojis.length;
