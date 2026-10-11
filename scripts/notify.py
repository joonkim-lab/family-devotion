#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
우리집 묵상 — 디스코드 알림 (키 없는 버전)
서비스 계정 키 대신 전용 계정 이메일/비번으로 Firebase 로그인 → Firestore 읽기.
GitHub Actions에서 9/10/11시(KST)에 실행.

* 비밀값은 전부 환경변수(Secrets)로만 받음 — 이 파일엔 비밀 없음.
* 축하 중복방지는 devotions/{날짜} 문서의 familyCelebrated 플래그로 처리 (notices 컬렉션 불필요 = 규칙 수정 불필요).
"""
import os
import datetime
import requests

PROJECT_ID = "fmoringdevotion"

# userKey ↔ 표시이름 (index.html FAMILY와 일치)
FAMILY = [
    ("joon",   "아빠"),
    ("spring", "Spring"),
    ("meriel", "Meriel"),
    ("jason",  "Jason"),
    ("elvin",  "Elvin"),
]

FS_BASE = f"https://firestore.googleapis.com/v1/projects/{PROJECT_ID}/databases/(default)/documents"


def kst_now():
    # GitHub Actions는 UTC. 한국시간 = UTC + 9h
    return datetime.datetime.utcnow() + datetime.timedelta(hours=9)


def sign_in(api_key, email, password):
    """전용 계정으로 로그인해 idToken 획득 (키 불필요)."""
    url = f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={api_key}"
    r = requests.post(url, json={
        "email": email, "password": password, "returnSecureToken": True
    }, timeout=20)
    if r.status_code != 200:
        raise SystemExit(f"로그인 실패({r.status_code}): {r.text[:300]}")
    return r.json()["idToken"]


def fs_get(path, token):
    """Firestore 문서 읽기. 없으면 None."""
    r = requests.get(f"{FS_BASE}/{path}",
                     headers={"Authorization": f"Bearer {token}"}, timeout=20)
    if r.status_code == 404:
        return None
    if r.status_code != 200:
        raise SystemExit(f"읽기 실패({r.status_code}) {path}: {r.text[:200]}")
    return r.json().get("fields", {})


def fs_bool(fields, key):
    return bool(fields and fields.get(key, {}).get("booleanValue") is True)


def fs_set_flag(path, token, field):
    """문서의 불리언 필드 하나만 true로 병합 저장."""
    url = f"{FS_BASE}/{path}?updateMask.fieldPaths={field}"
    r = requests.patch(url,
                       headers={"Authorization": f"Bearer {token}"},
                       json={"fields": {field: {"booleanValue": True}}}, timeout=20)
    if r.status_code != 200:
        print(f"플래그 저장 경고({r.status_code}): {r.text[:150]}")


def parse_ids(raw):
    ids = {}
    for pair in (raw or "").split(","):
        pair = pair.strip()
        if "=" in pair:
            k, v = pair.split("=", 1)
            ids[k.strip()] = v.strip()
    return ids


def post_discord(webhook, content, mention_ids):
    r = requests.post(webhook, json={
        "content": content,
        "allowed_mentions": {"users": mention_ids},  # 멘션이 실제로 핑 되도록
    }, timeout=20)
    r.raise_for_status()
    print("posted:", content.replace("\n", " "))


def main():
    api_key = os.environ["FIREBASE_API_KEY"]
    email = os.environ["DEVOTION_BOT_EMAIL"]
    password = os.environ["DEVOTION_BOT_PASSWORD"]
    webhook = os.environ["DISCORD_WEBHOOK_URL"]
    ids = parse_ids(os.environ.get("DISCORD_IDS", ""))

    now = kst_now()
    date = now.strftime("%Y-%m-%d")
    hour = now.hour
    # 안전장치: KST 21~23시가 아니면 보내지 않음 (지연 실행이 새벽에 도는 것 방지)
    # 수동 테스트는 FORCE_RUN=1 로 우회
    if hour not in (21, 22, 23) and os.environ.get("FORCE_RUN") != "1":
        print(f"KST {hour}시 — 알림 시간대(21~23시) 아님, 종료")
        return

    # 밤 9시(21)=가볍게, 10시(22)=한 번 더, 11시(23)=마지막 경고
    level = 1 if hour <= 21 else (2 if hour == 22 else 3)

    token = sign_in(api_key, email, password)

    # 오늘 묵상이 아직 생성 안 됐으면 알릴 게 없음 → 종료
    devo = fs_get(f"devotions/{date}", token)
    if devo is None:
        print("오늘 묵상 미생성 — 알림 생략")
        return

    def mention(key, name):
        did = ids.get(key)
        return f"<@{did}>" if did else name

    # 안 한 사람 추리기
    incomplete = []
    for key, name in FAMILY:
        fields = fs_get(f"progress/{date}_{key}", token)
        if not fs_bool(fields, "completed"):
            incomplete.append((key, name))

    # --- 전원 완료 → 축하 (하루 1회, devotions 플래그로 중복방지) ---
    if not incomplete:
        if fs_bool(devo, "familyCelebrated"):
            print("이미 축하함 — 생략")
            return
        post_discord(webhook,
                     "🎉 오늘 우리 가족은 모두 묵상을 마쳤어요^^ 수고했어요, 가족 여러분! 🌿",
                     list(ids.values()))
        fs_set_flag(f"devotions/{date}", token, "familyCelebrated")
        return

    # --- 미완료 → 단계별 알림 (9시<10시<11시 점점 강하게) ---
    used_ids = [ids[k] for k, _ in incomplete if k in ids]
    mentions = " ".join(mention(k, n) for k, n in incomplete)

    if level == 1:      # 밤 9시 — 가볍게
        msg = (f"🌿 오늘 하루도 마무리 시간이에요. 아직 묵상 전인 가족: {mentions}\n"
               f"자기 전에 잠깐, 오늘 말씀 어때요? :)")
    elif level == 2:    # 밤 10시 — 한 번 더
        msg = (f"⏰ 벌써 밤 10시예요! 아직 묵상 안 하신 분: {mentions}\n"
               f"오늘 넘어가기 전에 잠깐 시간 내봐요.")
    else:               # 밤 11시 — 마지막, 강하게
        msg = (f"🔔 오늘의 마지막 알림이에요! 아직 묵상 전: {mentions}\n"
               f"오늘 넘기지 말고 꼭 함께해요 🙏")

    post_discord(webhook, msg, used_ids)


if __name__ == "__main__":
    main()
