#!/usr/bin/env python3
"""Invented raw data for suite 7 (mid-air text entry with four virtual keyboards). Deterministic; no real people.

Writes raw/ files like a lab's logs and questionnaires:
  raw/participants.csv   participant, order (balanced 4 x 4 Latin square: four orders, six people each)
  raw/background.csv     participant, age_band, desktop_typing_wpm, smartphone_swipe_use,
                         first_language_english, wears_glasses, handedness, arm_length_cm
  raw/phrases.csv        one row per scored phrase: presented and transcribed text, seconds from the
                         first key (or gesture) to Enter
  raw/questionnaire.csv  per keyboard: the six raw NASA-TLX items (0-100, steps of 5) and
                         arm and shoulder comfort (1-7)
  raw/ranking.csv        per keyboard: preference rank after all four (1 = first)

The participant background drives the invented outcomes, so person-level forecasts have something to
find (moderate effects with noise; all invented for this example):
  - desktop typing speed (pre-study typing test) makes people faster with the raycast and split
    keyboards, a little with the drum keyboard, hardly with swipe;
  - daily smartphone swipe users are much faster with the swipe keyboard and make fewer word errors
    with it (people who never swipe are slower and make more), and find it less demanding;
  - longer arms mean less arm and shoulder strain with the drum keyboard (higher comfort, lower
    physical demand), whose keys sit at a fixed distance in front of the body;
  - people whose first language is not English are slightly slower on every keyboard and get more
    word substitutions from the swipe recogniser.
Age band, glasses and handedness have no effect. A small learning effect follows the position of a
keyboard in a person's order. Then convert_to_human.py builds ../human.json.
"""
import csv
import math
import os
import random

rng = random.Random(20261125)
here = os.path.dirname(os.path.abspath(__file__))
raw = os.path.join(here, "raw")
os.makedirs(raw, exist_ok=True)

KEYBOARDS = ["raycast", "drum", "swipe", "split"]
# Balanced Latin square (Williams design for four conditions): every keyboard once in every position,
# and every keyboard directly follows every other keyboard exactly once.
ORDERS = [
    ["raycast", "drum", "split", "swipe"],
    ["drum", "swipe", "raycast", "split"],
    ["swipe", "split", "drum", "raycast"],
    ["split", "raycast", "swipe", "drum"],
]
N = 24
PHRASES_PER_KEYBOARD = 10
# Forty short phrases written for this example in the style of a text-entry phrase set:
# lowercase letters and spaces only. Each person gets all forty in a random order, ten per keyboard.
PHRASES = [
    "the kettle is on the stove",
    "please water the plants today",
    "our bus leaves at seven",
    "bring a coat in case it rains",
    "the library closes early on friday",
    "she painted the fence bright blue",
    "a quiet room helps me think",
    "the river froze last winter",
    "we watched the sunrise from the hill",
    "my sister plays the cello",
    "keep the receipt for the shoes",
    "the meeting moved to tuesday",
    "he forgot his umbrella again",
    "fresh bread smells wonderful",
    "turn left after the bakery",
    "the cat sleeps on the windowsill",
    "call me when you get home",
    "the soup needs a pinch of salt",
    "they planted apple trees in spring",
    "the elevator is out of order",
    "a long walk clears the mind",
    "the train was full this morning",
    "please close the door quietly",
    "the museum opens at ten",
    "we ran out of milk",
    "the kite got stuck in a tree",
    "his garden grows huge pumpkins",
    "dinner will be ready soon",
    "the map was folded the wrong way",
    "the children built a sand castle",
    "my phone battery is almost empty",
    "the bridge is closed for repairs",
    "she knits warm socks for winter",
    "the concert starts at eight",
    "leave the keys under the mat",
    "the old clock still keeps time",
    "we found a path through the park",
    "the printer needs new paper",
    "the lake is calm this evening",
    "the puppy chewed my slipper",
]
# Words a gesture recogniser can confuse with a phrase word (similar paths over the keys).
LEXICON = sorted(set(" ".join(PHRASES).split()) | set(
    "a an as at be by he if in is it me my no of on or so to up we "
    "bag ban bat bed bet big bit bud bun bus but cab can cap car cat cot cut den dig dim dot dry "
    "fan far fat few fig fin fit fog for fun gap gas get got gum hat hen hid him hip his hit hot "
    "hug hut ink jam jar jet job jog key kid kin kit lap law leg let lid lip lit log lot mad map mat "
    "men met mix mob mom mud mug nap net new not nut oak odd oil old one our out pan pat pen pet pin "
    "pit pot put ran rat red rib rid rim rip rod rot row rub run sad sat saw set sip sit six sky son "
    "sun tan tap tea ten tin tip toe ton top toy tub two use van vet war was wax web wet who why win "
    "wit yes yet zip "
    "bake band bank bark barn bean bear beat bell belt bend best bike bird blow blue boat bold bolt "
    "bond bone book boot bowl bread brew brick bridge bright bring brown bunch cake call calm came "
    "camp cane card care cart case cash cast cave cell chain chair chalk cheap cheer chest child "
    "chill clean clear clock close cloth cloud coal coat code coin cold come cook cool cope cord "
    "core corn cost cove crew crop cross crow dance dark dart date dawn deal dear deep deer desk "
    "dine dish dive dock door dose down drag draw drew drop drum duck dull dune dust each early "
    "earn east easy edge empty ever face fact fade fail fair fall fame farm fast fear feed feel "
    "fence field file fill film find fine fire firm fish five flag flat flew flow fold folk fond "
    "food fool foot form fort four free fresh frog from frost full game gate gave gift give glad "
    "glow goal goes gold golf gone good grab grain grand grass grew grow hall hand hard harm have "
    "head heal heap hear heat help herd here hide high hill hint hold hole home hope horn horse "
    "hose huge hunt idle iron item jump just keen keep kept kind king kite knee knit knot know lace "
    "lake lamb lamp land lane last late lawn lead leaf lean left lend less life lift like lime line "
    "link lion list live load loaf loan lock long look loop lose loud love luck made mail main make "
    "mall many mark mask meal mean meat meet melt mild mile milk mind mine mint miss mode mold moon "
    "more most move much must nail name near neat neck need nest next nice nine none noon nose note "
    "open oven over pace pack page paid pain pair pale palm park part pass past path peak pear pick "
    "pile pine pink pipe plan play plot plum poem pole pond pool poor pork port pose post pour pull "
    "pump pure push race rain rake ramp rang rare rate read real rest rice rich ride ring rise road "
    "rock role roll roof room root rope rose rule rush safe sail salt same sand save seal seat seed "
    "seek seen self sell send ship shoe shop shot show shut side sign silk sing sink site size skin "
    "slip slow snow soap sock soft soil sold some song soon sort soup spin spot star stay step stir "
    "stop such suit sure swim tail take tale talk tall tame tank tape task team tell tend tent term "
    "test than that them then they thin this tide tile time tiny tire told toll tone took tool tour "
    "town tray tree trim trip true tune turn twin type unit vase vast very view vine vote wade wage "
    "wait wake walk wall want ward warm warn wash wave wear weed week well went were west what when "
    "whip wide wife wild will wind wine wing wire wise wish with wolf wood wool word wore work worm "
    "yard yarn year yell your zone".split()))


def clip(x, lo, hi):
    return max(lo, min(hi, x))


# Neighbouring keys on a QWERTY layout (rows offset as on a keyboard), for tapping slips.
ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"]
POS = {ch: (c + (0, 0.25, 0.75)[r], r) for r, row in enumerate(ROWS) for c, ch in enumerate(row)}
NEIGHBOURS = {a: sorted(b for b in POS if b != a and math.dist(POS[a], POS[b]) <= 1.2) for a in POS}


def tap_slips(text, p_char):
    """Uncorrected character errors of a key-by-key keyboard: a neighbouring key, a missed or an extra key."""
    out = []
    for ch in text:
        if rng.random() < p_char:
            kind = rng.random()
            if kind < 0.6 and ch in NEIGHBOURS:
                out.append(rng.choice(NEIGHBOURS[ch]))
            elif kind < 0.85:
                continue
            else:
                out.append(ch)
                out.append(rng.choice(NEIGHBOURS[ch]) if ch in NEIGHBOURS else ch)
        else:
            out.append(ch)
    return "".join(out) or text[0]


def swipe_slips(text, p_word):
    """Uncorrected errors of a word-gesture keyboard: a whole word replaced by a similar one."""
    words = []
    for w in text.split():
        if len(w) > 1 and rng.random() < p_word:
            similar = [x for x in LEXICON if x != w and x[0] == w[0] and abs(len(x) - len(w)) <= 1]
            words.append(rng.choice(similar) if similar else w[:-1])
        else:
            words.append(w)
    return " ".join(words)


BASE_WPM = {"raycast": 13.0, "drum": 14.0, "swipe": 12.5, "split": 7.6}
TYPING_SLOPE = {"raycast": 0.13, "drum": 0.05, "swipe": 0.02, "split": 0.12}  # per 20 desktop wpm
SWIPE_USE = {"never": 0.72, "sometimes": 1.0, "daily": 1.42}
LEARNING = [1.0, 1.04, 1.07, 1.09]  # first, second, third, fourth keyboard in a person's order
P_CHAR = {"raycast": 0.010, "drum": 0.016, "split": 0.009}
P_WORD = {"never": 0.12, "sometimes": 0.07, "daily": 0.03}
TLX_BASE = {"raycast": 42, "drum": 45, "swipe": 44, "split": 54}
TLX_ITEM = {  # offsets per item from the keyboard's base
    "raycast": {"mental": 5, "physical": 3, "temporal": 0, "performance": -15, "effort": 3, "frustration": -2},
    "drum": {"mental": 0, "physical": 14, "temporal": 0, "performance": -14, "effort": 5, "frustration": -2},
    "swipe": {"mental": 5, "physical": 0, "temporal": -2, "performance": -12, "effort": 0, "frustration": 4},
    "split": {"mental": 8, "physical": -12, "temporal": 5, "performance": -16, "effort": 10, "frustration": 2},
}
COMFORT_BASE = {"raycast": 4.6, "drum": 3.5, "swipe": 4.5, "split": 5.6}

# Background: balanced lists shuffled with the seed, so every category is present and the cohort is varied.
def shuffled(values):
    values = list(values)
    rng.shuffle(values)
    return values


ages = shuffled(["18-24"] * 7 + ["25-34"] * 9 + ["35-44"] * 5 + ["45+"] * 3)
swipe_use = shuffled(["never"] * 7 + ["sometimes"] * 9 + ["daily"] * 8)
english = shuffled(["yes"] * 15 + ["no"] * 9)
glasses = shuffled(["yes"] * 9 + ["no"] * 15)
hands = shuffled(["right"] * 21 + ["left"] * 3)

participants, background, phrases, questionnaire, ranking = [], [], [], [], []
for i in range(N):
    pid = f"P{i + 1:02d}"
    order = ORDERS[i % 4]
    participants.append({"participant": pid, "order": " ".join(order)})
    desktop = int(round(clip(rng.gauss(62, 18), 25, 115)))
    arm = int(round(clip(rng.gauss(73, 4.5), 62, 85)))
    person = {
        "participant": pid,
        "age_band": ages[i],
        "desktop_typing_wpm": desktop,
        "smartphone_swipe_use": swipe_use[i],
        "first_language_english": english[i],
        "wears_glasses": glasses[i],
        "handedness": hands[i],
        "arm_length_cm": arm,
    }
    background.append(person)
    typing = (desktop - 60) / 20
    reach = arm - 73
    skill = rng.gauss(0, 0.08)
    workload_bias = rng.gauss(0, 7)
    comfort_bias = rng.gauss(0, 0.45)
    pool = shuffled(PHRASES)
    utility = {}
    for pos, kb in enumerate(order):
        wpm = BASE_WPM[kb] * math.exp(skill + TYPING_SLOPE[kb] * typing + rng.gauss(0, 0.07)) * LEARNING[pos]
        if kb == "swipe":
            wpm *= SWIPE_USE[person["smartphone_swipe_use"]]
        if person["first_language_english"] == "no":
            wpm *= 0.95
        error_scale = math.exp(rng.gauss(0, 0.3))
        p_char = clip(P_CHAR.get(kb, 0) * error_scale * (1 - 0.08 * typing), 0.002, 0.08)
        p_word = clip(P_WORD[person["smartphone_swipe_use"]] * error_scale * (1.25 if person["first_language_english"] == "no" else 1), 0.005, 0.3)
        speeds, wrong = [], []
        for n, presented in enumerate(pool[pos * PHRASES_PER_KEYBOARD:(pos + 1) * PHRASES_PER_KEYBOARD]):
            transcribed = swipe_slips(presented, p_word) if kb == "swipe" else tap_slips(presented, p_char)
            phrase_wpm = clip(wpm * math.exp(rng.gauss(0, 0.12)), 2.5, 45)
            seconds = (len(transcribed) - 1) * 12 / phrase_wpm
            speeds.append(phrase_wpm)
            wrong.append(sum(a != b for a, b in zip(presented, transcribed)) + abs(len(presented) - len(transcribed)))
            phrases.append({"participant": pid, "keyboard": kb, "position": pos + 1, "phrase": n + 1, "presented": presented, "transcribed": transcribed, "seconds": f"{seconds:.2f}"})
        mean_wpm = sum(speeds) / len(speeds)
        slips = sum(wrong) / sum(len(p) for p in pool[pos * PHRASES_PER_KEYBOARD:(pos + 1) * PHRASES_PER_KEYBOARD])
        load = TLX_BASE[kb] + workload_bias - 0.8 * (mean_wpm - BASE_WPM[kb])
        if kb == "swipe":
            load += {"never": 6, "sometimes": 0, "daily": -8}[person["smartphone_swipe_use"]]
        items = {}
        for item, offset in TLX_ITEM[kb].items():
            v = load + offset + rng.gauss(0, 7)
            if item == "performance":
                v += 250 * slips
            if item == "frustration" and kb == "swipe":
                v += 150 * slips
            if kb == "drum" and item == "physical":
                v -= 2.0 * reach
            if kb == "drum" and item == "effort":
                v -= 0.7 * reach
            items[item] = int(clip(5 * round(v / 5), 0, 100))
        comfort = COMFORT_BASE[kb] + comfort_bias + (0.15 * reach if kb == "drum" else 0) + rng.gauss(0, 0.55)
        comfort = int(clip(round(comfort), 1, 7))
        questionnaire.append({"participant": pid, "keyboard": kb, **{f"tlx_{k}": v for k, v in items.items()}, "arm_comfort": comfort})
        utility[kb] = 0.08 * mean_wpm - 0.03 * sum(items.values()) / 6 + 0.35 * comfort + rng.gauss(0, 0.6)
    ranked = sorted(KEYBOARDS, key=lambda k: -utility[k])
    for kb in KEYBOARDS:
        ranking.append({"participant": pid, "keyboard": kb, "rank": ranked.index(kb) + 1})


def write(name, rows):
    with open(os.path.join(raw, name), "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()), lineterminator="\n")
        w.writeheader()
        w.writerows(rows)


write("participants.csv", participants)
write("background.csv", background)
write("phrases.csv", phrases)
write("questionnaire.csv", questionnaire)
write("ranking.csv", ranking)
print(f"wrote {len(participants)} participants, {len(phrases)} scored phrases to {raw}")
