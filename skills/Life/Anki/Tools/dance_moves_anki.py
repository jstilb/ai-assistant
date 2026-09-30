"""
dance_moves_anki.py — collection-side half of DanceMoves.ts.

Reads one JSON request on stdin, applies it to the Anki collection with the
anki library that ships with apy, and prints one JSON result on stdout.
Anki desktop must be CLOSED (the collection is locked while it runs).

Request: {"op": "sync"|"learn"|"unlearn"|"add"|"list", "collection": <path|null>, ...}
  sync    {"moves": [Move...]}            upsert catalogue notes; new ones are suspended
  learn   {"key", "learned", "clip"?, "video"?, "dueDays"?}   unsuspend + stamp Learned
  unlearn {"key"}                         re-suspend, clear Learned
  add     {"move": Move, "learned", "clip"?, "dueDays"?}      custom move, created learned
  list    {}                              every Kaya Dance Move note
"""

import json
import re
import sys

from anki.collection import Collection

NOTETYPE = "Kaya Dance Move"
FIELDS = ["MoveKey", "Move", "Dance", "Block", "Breakdown", "Video", "VideoTitle", "VideoId", "Learned", "MyClip"]
LEARNED_TAG = "move-learned"
SECTION = "Moves Learned"

FRONT = """<div class="dm-meta">{{Dance}}{{#Block}} · {{Block}}{{/Block}}</div>
<div class="dm-move">{{Move}}</div>
<div class="dm-prompt">Stand up and dance it: 8 counts, on the beat, groove underneath. Then flip.</div>"""

BACK = """{{FrontSide}}
<hr id="answer">
<div class="dm-breakdown">{{Breakdown}}</div>
{{#Video}}<div class="dm-video"><a href="{{Video}}">{{#VideoId}}<img src="https://img.youtube.com/vi/{{VideoId}}/mqdefault.jpg"><br>{{/VideoId}}▶ {{#VideoTitle}}{{VideoTitle}}{{/VideoTitle}}{{^VideoTitle}}Watch the move{{/VideoTitle}}</a></div>{{/Video}}
{{#MyClip}}<div class="dm-video"><a href="{{MyClip}}">▶ My clip</a></div>{{/MyClip}}
{{#Learned}}<div class="dm-learned">Learned: {{Learned}}</div>{{/Learned}}"""

CSS = """.card { font-family: -apple-system, Helvetica, Arial, sans-serif; font-size: 20px; text-align: center; color: #1d1d1f; background: #fff; }
.nightMode .card, .night_mode .card { color: #f5f5f7; background: #1c1c1e; }
.dm-meta { font-size: 13px; letter-spacing: .06em; text-transform: uppercase; opacity: .6; }
.dm-move { font-size: 30px; font-weight: 700; margin: 10px 0; }
.dm-prompt { font-size: 15px; opacity: .7; }
.dm-breakdown { text-align: left; max-width: 620px; margin: 0 auto 14px; line-height: 1.45; }
.dm-video { margin: 10px 0; }
.dm-video img { max-width: 320px; width: 100%; border-radius: 8px; }
.dm-video a { text-decoration: none; font-weight: 600; }
.dm-learned { font-size: 13px; opacity: .6; margin-top: 12px; }"""

YT_ID = re.compile(r"(?:youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|embed/)|youtu\.be/)([A-Za-z0-9_-]{11})")


def video_id(url):
    m = YT_ID.search(url or "")
    return m.group(1) if m else ""


def default_collection_path():
    from apyanki.config import cfg
    import os
    base = cfg["base_path"]
    profile = cfg.get("profile_name") or "User 1"
    return os.path.join(base, profile, "collection.anki2")


def ensure_notetype(col):
    mm = col.models
    m = mm.by_name(NOTETYPE)
    if m is None:
        m = mm.new(NOTETYPE)
        for name in FIELDS:
            mm.add_field(m, mm.new_field(name))
        t = mm.new_template("Perform")
        t["qfmt"], t["afmt"] = FRONT, BACK
        mm.add_template(m, t)
        m["css"] = CSS
        m["sortf"] = FIELDS.index("Move")
        mm.add(m)
        return mm.by_name(NOTETYPE), True
    # Template/CSS text only — never touch fields (that forces a full AnkiWeb sync).
    t = m["tmpls"][0]
    if t["qfmt"] != FRONT or t["afmt"] != BACK or m["css"] != CSS:
        t["qfmt"], t["afmt"], m["css"] = FRONT, BACK, CSS
        mm.save(m)
    return m, False


def deck_name(subject):
    return f"Learning::{subject}::{SECTION}"


def find_note(col, key):
    nids = col.find_notes(f'"note:{NOTETYPE}" "MoveKey:{key}"')
    return col.get_note(nids[0]) if nids else None


def fill(note, move):
    note["MoveKey"] = move["key"]
    note["Move"] = move["move"]
    note["Dance"] = move.get("dance", "")
    note["Block"] = move.get("block", "")
    note["Breakdown"] = move.get("breakdown", "")
    note["Video"] = move.get("video", "")
    note["VideoTitle"] = move.get("videoTitle", "")
    note["VideoId"] = video_id(move.get("video", ""))


def tags_for(move):
    style = "hip-hop" if move["subject"] == "Hip Hop Dance" else "salsa-bachata"
    return ["dance-move", style, "kaya-auto"]


def op_sync(col, req):
    model, created_type = ensure_notetype(col)
    added, updated, unchanged = [], [], []
    for move in req["moves"]:
        note = find_note(col, move["key"])
        if note is None:
            note = col.new_note(model)
            fill(note, move)
            note.tags = tags_for(move)
            col.add_note(note, col.decks.id(deck_name(move["subject"])))
            col.sched.suspend_cards(note.card_ids())
            added.append(move["key"])
            continue
        before = list(note.fields)
        fill(note, move)
        if list(note.fields) != before:
            col.update_note(note)
            updated.append(move["key"])
        else:
            unchanged.append(move["key"])
    return {"notetypeCreated": created_type, "added": added, "updated": updated, "unchanged": unchanged}


def mark_learned(col, note, req):
    note["Learned"] = req["learned"]
    if req.get("clip"):
        note["MyClip"] = req["clip"]
    if req.get("video"):
        note["Video"] = req["video"]
        note["VideoId"] = video_id(req["video"])
        if req.get("videoTitle") is not None:
            note["VideoTitle"] = req["videoTitle"]
    note.add_tag(LEARNED_TAG)
    col.update_note(note)
    cids = note.card_ids()
    col.sched.unsuspend_cards(cids)
    due_days = req.get("dueDays")
    if due_days is not None:
        col.sched.set_due_date(cids, str(due_days))
    return {"key": note["MoveKey"], "move": note["Move"], "cardIds": cids, "dueDays": due_days}


def op_learn(col, req):
    note = find_note(col, req["key"])
    if note is None:
        raise KeyError(f"No '{NOTETYPE}' note with MoveKey {req['key']} — run `DanceMoves.ts sync` first")
    return mark_learned(col, note, req)


def op_unlearn(col, req):
    note = find_note(col, req["key"])
    if note is None:
        raise KeyError(f"No '{NOTETYPE}' note with MoveKey {req['key']}")
    note["Learned"] = ""
    note.remove_tag(LEARNED_TAG)
    col.update_note(note)
    col.sched.suspend_cards(note.card_ids())
    return {"key": req["key"], "suspended": True}


def op_add(col, req):
    move = req["move"]
    if find_note(col, move["key"]) is not None:
        raise ValueError(f"MoveKey {move['key']} already exists — use `learn` instead")
    model, _ = ensure_notetype(col)
    note = col.new_note(model)
    fill(note, move)
    note.tags = [t for t in tags_for(move) if t != "kaya-auto"] + ["custom-move"]
    col.add_note(note, col.decks.id(deck_name(move["subject"])))
    return mark_learned(col, note, req)


def op_list(col, _req):
    out = []
    for nid in col.find_notes(f'"note:{NOTETYPE}"'):
        note = col.get_note(nid)
        cards = note.cards()
        out.append({
            "key": note["MoveKey"],
            "move": note["Move"],
            "dance": note["Dance"],
            "deck": col.decks.name(cards[0].did) if cards else "",
            "learned": note["Learned"],
            "suspended": all(c.queue == -1 for c in cards),
            "video": note["Video"],
        })
    return {"notes": out}


OPS = {"sync": op_sync, "learn": op_learn, "unlearn": op_unlearn, "add": op_add, "list": op_list}


def main():
    req = json.load(sys.stdin)
    path = req.get("collection") or default_collection_path()
    col = Collection(path)
    try:
        result = OPS[req["op"]](col, req)
    finally:
        col.close()
    print(json.dumps({"ok": True, **result}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # surfaced to the TS caller as a typed failure
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))
        sys.exit(1)
