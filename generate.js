// ════════════════════════════════════════════════════
// 묵상 생성 모듈 (아빠 전용)
// 흐름: ODB 오늘 글(wp-json) → 성경 본문(개역개정) → Claude 연령별 4버전 → Firestore
// 시간대 규칙: 사용자가 보는 건 한국 시간, ODB 글은 "한국 날짜 -1일"
// ODB 접근: wp-json REST API 직접 조회 (검색 의존 없음 = 안정적)
// ════════════════════════════════════════════════════

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const API_URL = 'https://api.anthropic.com/v1/messages';

// ── 성경 파싱 (기존 앱에서 검증된 부품 재활용) ──
let _bible = null;
async function loadBible() {
  if (_bible) return _bible;
  const r = await fetch('bible-krv.json');
  _bible = await r.json();
  return _bible;
}
const BOOK_EN_TO_KO = {'genesis':'창','exodus':'출','leviticus':'레','numbers':'민','deuteronomy':'신','joshua':'수','judges':'삿','ruth':'룻','1samuel':'삼상','2samuel':'삼하','1kings':'왕상','2kings':'왕하','1chronicles':'대상','2chronicles':'대하','ezra':'스','nehemiah':'느','esther':'에','job':'욥','psalms':'시','psalm':'시','proverbs':'잠','ecclesiastes':'전','songofsolomon':'아','isaiah':'사','jeremiah':'렘','lamentations':'애','ezekiel':'겔','daniel':'단','hosea':'호','joel':'욜','amos':'암','obadiah':'옵','jonah':'욘','micah':'미','nahum':'나','habakkuk':'합','zephaniah':'습','haggai':'학','zechariah':'슥','malachi':'말','matthew':'마','mark':'막','luke':'눅','john':'요','acts':'행','romans':'롬','1corinthians':'고전','2corinthians':'고후','galatians':'갈','ephesians':'엡','philippians':'빌','colossians':'골','1thessalonians':'살전','2thessalonians':'살후','1timothy':'딤전','2timothy':'딤후','titus':'딛','philemon':'몬','hebrews':'히','james':'약','1peter':'벧전','2peter':'벧후','1john':'요일','2john':'요이','3john':'요삼','jude':'유','revelation':'계'};
const BOOK_KO_FULL = {'창':'창세기','출':'출애굽기','레':'레위기','민':'민수기','신':'신명기','수':'여호수아','삿':'사사기','룻':'룻기','삼상':'사무엘상','삼하':'사무엘하','왕상':'열왕기상','왕하':'열왕기하','대상':'역대상','대하':'역대하','스':'에스라','느':'느헤미야','에':'에스더','욥':'욥기','시':'시편','잠':'잠언','전':'전도서','아':'아가','사':'이사야','렘':'예레미야','애':'예레미야애가','겔':'에스겔','단':'다니엘','호':'호세아','욜':'요엘','암':'아모스','옵':'오바댜','욘':'요나','미':'미가','나':'나훔','합':'하박국','습':'스바냐','학':'학개','슥':'스가랴','말':'말라기','마':'마태복음','막':'마가복음','눅':'누가복음','요':'요한복음','행':'사도행전','롬':'로마서','고전':'고린도전서','고후':'고린도후서','갈':'갈라디아서','엡':'에베소서','빌':'빌립보서','골':'골로새서','살전':'데살로니가전서','살후':'데살로니가후서','딤전':'디모데전서','딤후':'디모데후서','딛':'디도서','몬':'빌레몬서','히':'히브리서','약':'야고보서','벧전':'베드로전서','벧후':'베드로후서','요일':'요한일서','요이':'요한이서','요삼':'요한삼서','유':'유다서','계':'요한계시록'};

function parseVerseRange(ref) {
  const m = ref.match(/^([\w\s]+?)\s+(\d+):(.+)/);
  if (!m) return null;
  const bookRaw = m[1].toLowerCase().replace(/\s+/g,'').replace(/[^a-z0-9]/g,'');
  const chapter = m[2], versesPart = m[3];
  const abbr = BOOK_EN_TO_KO[bookRaw] || null;
  if (!abbr) return null;
  const verseNums = [];
  versesPart.split(',').forEach(seg => {
    const r = seg.trim().match(/^(\d+)(?:-(\d+))?/);
    if (!r) return;
    const from = parseInt(r[1]), to = r[2] ? parseInt(r[2]) : from;
    for (let v = from; v <= to; v++) verseNums.push(v);
  });
  return { abbr, chapter, verseNums, bookFull: BOOK_KO_FULL[abbr] || abbr };
}
async function fetchBiblePassage(ref) {
  const bible = await loadBible();
  const parsed = parseVerseRange(ref);
  if (!parsed) throw new Error('성경 구절 파싱 실패: ' + ref);
  const verses = [];
  parsed.verseNums.forEach(v => {
    const t = bible[`${parsed.abbr}${parsed.chapter}:${v}`];
    if (t) verses.push({ num: String(v), text: t.trim() });
  });
  if (!verses.length) throw new Error('구절을 찾을 수 없습니다: ' + ref);
  return { book_ko: parsed.bookFull, verses };
}
function keyVerseKo(keyRef) {
  // 핵심 구절 한 절만 개역개정으로
  return loadBible().then(bible => {
    const p = parseVerseRange(keyRef);
    if (!p || !p.verseNums.length) return '';
    const t = bible[`${p.abbr}${p.chapter}:${p.verseNums[0]}`];
    return t ? t.trim() : '';
  });
}

// ── Claude 호출 (기존 앱 부품 재활용) ──
async function callClaude(messages, options = {}) {
  const key = localStorage.getItem('anthropic_api_key');
  if (!key) throw new Error('API 키가 없습니다. 아빠 기기에서 API 키를 먼저 저장해주세요.');
  const body = { model: CLAUDE_MODEL, max_tokens: options.maxTokens || 4000, messages };
  if (options.tools) body.tools = options.tools;
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  };
  if (options.tools && options.tools.some(t => t.type && t.type.startsWith('web_fetch'))) {
    headers['anthropic-beta'] = 'web-fetch-2025-09-10';
  }
  const res = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) { const t = await res.text(); throw new Error(`HTTP ${res.status}: ${t.slice(0,300)}`); }
  const data = await res.json();
  return data.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

function parseJSON(text) {
  let clean = text.trim().replace(/^```json\s*/i,'').replace(/```\s*$/i,'').replace(/^```\s*/i,'').trim();
  const fb = clean.search(/[{\[]/);
  if (fb === -1) throw new Error('JSON 시작 문자 없음');
  const closeChar = clean[fb] === '[' ? ']' : '}';
  clean = clean.slice(fb, clean.lastIndexOf(closeChar) + 1);
  clean = clean.replace(/"((?:[^"\\]|\\.)*)"/g, (mt, inner) => '"' + inner.replace(/\r?\n/g, '\\n') + '"');
  return JSON.parse(clean);
}

// ── ODB 오늘 글 가져오기 (wp-json REST API 직접 조회) ──
// 한국 날짜 -1일 = ODB 목표 날짜. CDN 캐시 우회.
function getOdbDateFor(koreaDate) {
  const d = new Date(koreaDate);
  d.setDate(d.getDate() - 1);
  return d;
}
function odbDateHuman(date) {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

async function fetchOdbToday(koreaDate) {
  const odbDate = getOdbDateFor(koreaDate);
  const human = odbDateHuman(odbDate);
  // wp-json 직접 조회를 Claude web_fetch로 처리(브라우저 CORS 회피 + 본문 추출 일괄)
  const y = odbDate.getFullYear();
  const m = String(odbDate.getMonth()+1).padStart(2,'0');
  const d = String(odbDate.getDate()).padStart(2,'0');
  const apiUrl = `https://ourdailybreadministries.ca/wp-json/wp/v2/posts?after=${y}-${m}-${d}T00:00:00&before=${y}-${m}-${d}T23:59:59&per_page=5`;

  const prompt = `다음 Our Daily Bread Canada의 wp-json API에서 ${human}자 묵상 글을 가져와 내용을 추출하세요:
${apiUrl}

API 응답은 JSON 배열입니다. ${human}에 해당하는 묵상 글(devotional) 하나를 찾으세요.
각 글의 content.rendered 안에 본문 HTML이 들어있습니다.

오직 JSON만 반환 (코드 블록 금지, { 로 시작):
{
  "found": true 또는 false,
  "title": "영문 제목",
  "scripture_ref": "본문 구절 범위, 예: '1 Corinthians 13:8-13' (책이름 장:절)",
  "key_verse": "핵심 인용 구절 본문 (큰따옴표 대신 작은따옴표)",
  "key_verse_ref": "핵심 구절 출처, 예: 1 Corinthians 13:12",
  "message_body": "묵상 본문 전체. HTML 태그 제외 순수 텍스트, 줄바꿈은 공백으로, 큰따옴표 대신 작은따옴표",
  "author": "저자 이름",
  "reflection_question": "Reflect 질문 텍스트",
  "prayer": "기도문"
}

${human}자 글을 못 찾으면 found:false. 코드 블록 금지.`;

  const text = await callClaude([{ role:'user', content: prompt }], {
    tools: [{ type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 2,
              allowed_domains: ['ourdailybreadministries.ca'] }],
    maxTokens: 6000
  });
  const meta = parseJSON(text);
  if (!meta.found) throw new Error(`${human}자 ODB 글을 찾지 못했습니다.`);
  meta.message_body = (meta.message_body || '').replace(/"/g, "'").replace(/\n/g, ' ').trim();
  meta.dateHuman = human;
  return meta;
}

// ── 연령별 4버전 묵상 한 번에 생성 ──
async function generateByAge(devo, kvKo) {
  const prompt = `아래 Our Daily Bread 묵상을 우리 가족을 위한 한국어 묵상으로 변환합니다.
본문(성경 구절)과 핵심 구절은 가족 모두 공통이고, 묵상/질문/기도만 연령별로 만듭니다.

[ODB 원문]
제목: ${devo.title}
성경 본문: ${devo.scripture_ref}
핵심 구절(개역개정): "${kvKo}" (${devo.key_verse_ref})
본문 메시지: ${devo.message_body}
원 기도문 참고: ${devo.prayer}

[연령 그룹 — 3가지]
- child  : 12세 어린이. 쉬운 일상 단어, 짧은 문장, 따뜻하게. 어려운 신학 용어 금지.
- teen   : 15-17세 청소년. 학교/친구/진로 같은 현실 맥락. 솔직하고 담백하게, 설교조 금지.
- adult  : 어른. 깊이 있되 일상 적용 중심. 정중체.

각 그룹마다:
- meditation: 2-3 단락. <p>로 단락 구분, <em>으로 핵심 강조. 그 연령에 맞는 언어.
- q1, q2: 본문 내용을 실제로 읽었는지 + 적용을 묻는 짧은 질문 2개. 같은 본문을 향하되 표현은 연령에 맞게. (가족이 나중에 함께 나눌 수 있는 질문)
- prayers: 기도제목 2개 (배열). 짧게.

[공통]
- title_ko: 한국어 제목 (모든 연령 공통, 하나만)
- 원어(헬라어/히브리어) 인용 금지.

[JSON 안전 규칙 — 매우 중요]
- 문자열 값 안에서 큰따옴표(") 절대 금지. 인용/강조는 작은따옴표(') 또는 「」.
- 줄바꿈 문자 금지. 단락은 <p>로만.
- 백슬래시 금지.

오직 JSON만 출력 (코드 블록 금지, { 로 시작 } 로 끝):
{
  "title_ko": "공통 한국어 제목",
  "child":  { "meditation": "...", "q1": "...", "q2": "...", "prayers": ["...","..."] },
  "teen":   { "meditation": "...", "q1": "...", "q2": "...", "prayers": ["...","..."] },
  "adult":  { "meditation": "...", "q1": "...", "q2": "...", "prayers": ["...","..."] }
}`;
  const text = await callClaude([{ role:'user', content: prompt }], { maxTokens: 5000 });
  return parseJSON(text);
}

// ════════════════════════════════════════════════════
// 메인 — 외부(index.html)에서 호출
// ════════════════════════════════════════════════════
export async function generateTodayDevotion(ctx) {
  const { db, doc, setDoc, getDoc, todayKey, getKoreaDate, setStep, showDevoView, loadToday, showToast } = ctx;

  if (!localStorage.getItem('anthropic_api_key')) {
    const k = prompt('Anthropic API 키를 입력하세요 (이 기기에만 저장됩니다):');
    if (!k || !k.startsWith('sk-ant-')) { showToast('올바른 API 키가 아니에요.'); return; }
    localStorage.setItem('anthropic_api_key', k.trim());
  }

  const dk = todayKey();
  // 이미 있으면 덮어쓰지 않음 (가족이 다른 글 보면 안 됨)
  const existing = await getDoc(doc(db, 'devotions', dk));
  if (existing.exists()) { showToast('오늘 묵상은 이미 준비되어 있어요.'); loadToday(); return; }

  showDevoView('progress');
  ['0','1','2','3'].forEach(i => setStep(i, ''));

  try {
    // 1. ODB 오늘 글
    setStep('0','active');
    const koreaDate = getKoreaDate();
    const devo = await fetchOdbToday(koreaDate);
    setStep('0','done', `ODB: ${devo.title}`);

    // 2. 성경 본문 + 핵심 구절 한글
    setStep('1','active');
    let passage = null, kvKo = '';
    try { passage = await fetchBiblePassage(devo.scripture_ref); } catch(e) { passage = null; }
    try { kvKo = await keyVerseKo(devo.key_verse_ref); } catch(e) { kvKo = ''; }
    setStep('1','done', passage ? `${passage.book_ko} ${passage.verses.length}절` : '본문 범위 확인');

    // 3. 연령별 생성
    setStep('2','active');
    const byAge = await generateByAge(devo, kvKo);
    setStep('2','done', '연령별 묵상 완료');

    // 4. Firestore 저장
    setStep('3','active');
    const record = {
      dateId: dk,
      title_en: devo.title,
      title_ko: byAge.title_ko || devo.title,
      author: devo.author || '',
      scripture_ref: devo.scripture_ref,
      key_verse_ko: kvKo || devo.key_verse || '',
      key_verse_ref: devo.key_verse_ref || '',
      passage: passage || null,
      byAge: {
        child: byAge.child,
        teen:  byAge.teen,
        adult: byAge.adult
      },
      createdAt: Date.now()
    };
    await setDoc(doc(db, 'devotions', dk), record);
    setStep('3','done', '가족에게 전달 완료!');

    showToast('오늘 가족 묵상이 준비됐어요 🌅');
    setTimeout(() => loadToday(), 700);

  } catch (err) {
    setStep('0','error', err.message || '생성 실패');
    showToast('생성 실패: ' + (err.message || ''));
    setTimeout(() => showDevoView('empty'), 1500);
  }
}
