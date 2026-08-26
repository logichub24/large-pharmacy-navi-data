// 국립중앙의료원(중앙응급의료센터) "전국 약국 정보 조회 서비스" 오픈API로 전국 약국의
// 위치·전화번호·요일별 운영시간을 가져와 시/도 단위 파일로 쪼개 저장한다.
// (편의점 앱의 scripts/storeLocations.js 와 동일한 출력 구조: stores/index.json + stores/<시도>.json)
//
// API 활용신청(무료, 자동승인): https://www.data.go.kr/data/15000576/openapi.do
// 서비스명: 국립중앙의료원_전국 약국 정보 조회 서비스 (ErmctInsttInfoInqireService)
//
// ⚠️ 알아두어야 할 점
// 1) 목록 조회(getParmacyListInfoInqire) 응답에 좌표·전화번호·요일별 운영시간이 이미 포함되어
//    있어서, 페이지네이션만으로 전국 데이터를 받을 수 있다(약국당 별도 상세 호출 불필요).
//    전국 약국 약 2만 4천여 개소 기준 페이지당 100건이면 약 250회 안팎의 호출로 끝나
//    개발계정 기본 할당량(1,000건/일)으로 한 번에 전체를 받을 수 있다.
//    그래도 만약을 위해 MAX_API_CALLS(기본 900)로 상한을 두고, 초과 시
//    scripts/.pharmacy-sync-cache.json에 "완료된 시/도" 목록을 저장해 다음 실행에서 이어간다.
//    (좌표가 비어있는 극히 일부 항목만 예외적으로 상세 조회를 추가로 호출한다.)
// 2) 이 API는 "주차 가능/드라이브 스루/건강기능식품/의료기기/혈압·혈당측정/취급 품목"처럼
//    이 앱이 강조하는 서비스 정보까지는 제공하지 않는다(정부 공개데이터의 한계).
//    이 값들은 data/service-overrides.json 에 약국 hpid 기준으로 직접 입력해두면
//    자동으로 병합되어 반영된다(운영자가 직접 확인해 채워 넣는 "큐레이션" 방식을 전제로 함).
// 3) 공휴일 운영 여부는 dutyTime8s/dutyTime8c(공휴일 진료시간) 필드 존재 여부로 판별한다.
//
// 사용법:
//   EGEN_API_KEY=발급받은_디코딩_키 node scripts/pharmacyLocations.js
//   (테스트로 일부 시/도만: SYNC_PROVINCES=세종특별자치시 EGEN_API_KEY=... node scripts/pharmacyLocations.js)
//
// EGEN_API_KEY를 환경변수로 넘기기 번거로우면, 이 스크립트 폴더 상위(.env)에
//   EGEN_API_KEY=발급받은키
// 한 줄을 적어두면 자동으로 읽는다(.env는 .gitignore에 포함되어 커밋되지 않음).

const fs = require('fs');
const path = require('path');
loadDotEnv();

const BASE_URL = 'https://apis.data.go.kr/B552657/ErmctInsttInfoInqireService'; // http로 호출하면 게이트웨이가 403을 반환하니 반드시 https 사용
const OUT_DIR = path.join(__dirname, '..', 'stores');
const CACHE_FILE = path.join(__dirname, '.pharmacy-sync-cache.json');
const OVERRIDES_FILE = path.join(__dirname, '..', 'data', 'service-overrides.json');
// 행안부 단독 등록 약국(E-Gen에 없어 별도 복구한 moi_ 레코드)과 폐업 판정 E-Gen id 목록.
// 이 둘은 로컬 CSV 기반의 1회성 큐레이션 결과를 커밋해둔 것으로, 매 동기화가 E-Gen을
// 새로 받아 파일을 덮어써도 moi_ 약국이 유실되지 않고 폐업분이 되살아나지 않도록 재적용한다.
const MOI_STANDALONE_FILE = path.join(__dirname, '..', 'data', 'moi-standalone.json');
const CLOSED_IDS_FILE = path.join(__dirname, '..', 'data', 'closed-egen-ids.json');
// 목록 조회(페이지네이션) + 상세 조회를 합쳐 이번 실행에서 쓸 최대 API 호출 수.
// 하루 기본 할당량(1,000건) 아래로 여유있게 잡아둔다.
const MAX_API_CALLS = parseInt(process.env.MAX_API_CALLS || '900', 10);

const ALL_PROVINCES = [
  '서울특별시', '부산광역시', '대구광역시', '인천광역시', '광주광역시', '대전광역시', '울산광역시',
  '세종특별자치시', '경기도', '강원특별자치도', '충청북도', '충청남도', '전북특별자치도', '전라남도',
  '경상북도', '경상남도', '제주특별자치도',
];
const PROVINCES = process.env.SYNC_PROVINCES
  ? process.env.SYNC_PROVINCES.split(',').map((s) => s.trim()).filter(Boolean)
  : ALL_PROVINCES;

function loadDotEnv() {
  if (process.env.EGEN_API_KEY) return;
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function loadJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { return fallback; }
}
function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data), 'utf-8');
}

class BudgetExceededError extends Error {}
class ApiCallBudget {
  constructor(max) { this.max = max; this.used = 0; }
  use() {
    if (this.used >= this.max) throw new BudgetExceededError();
    this.used++;
  }
}

// 이 API 계열(구형 공공데이터 Open API)은 계정 설정에 따라 XML 또는 JSON으로 응답한다.
// _type=json 을 붙여 JSON을 우선 시도하고, XML이 오면 간단한 정규식 파서로 폴백한다.
function parseSimpleXmlItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const body = m[1];
    const obj = {};
    const fieldRe = /<(\w+)>([\s\S]*?)<\/\1>/g;
    let fm;
    while ((fm = fieldRe.exec(body))) obj[fm[1]] = fm[2].trim();
    items.push(obj);
  }
  return items;
}

function extractItems(data) {
  if (typeof data === 'string') return parseSimpleXmlItems(data);
  const body = data?.response?.body;
  if (!body) return [];
  const items = body.items?.item ?? body.items ?? [];
  return Array.isArray(items) ? items : [items];
}

function extractTotalCount(data) {
  if (typeof data === 'string') {
    const m = data.match(/<totalCount>(\d+)<\/totalCount>/);
    return m ? parseInt(m[1], 10) : 0;
  }
  return parseInt(data?.response?.body?.totalCount || '0', 10);
}

function extractErrorMsg(data) {
  if (typeof data === 'string') {
    const m = data.match(/<(?:resultMsg|returnAuthMsg|errMsg)>([\s\S]*?)<\//);
    return m ? m[1].trim() : null;
  }
  const header = data?.response?.header;
  if (header && header.resultCode && header.resultCode !== '00' && header.resultCode !== '0') return header.resultMsg;
  return null;
}

async function callApi(budget, operation, params) {
  budget.use();
  const url = new URL(`${BASE_URL}/${operation}`);
  for (const [key, value] of Object.entries({ ...params, _type: 'json' })) url.searchParams.set(key, value);
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`API HTTP ${response.status}`);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  const errMsg = extractErrorMsg(data);
  if (errMsg) throw new Error(`API 오류: ${errMsg}`);
  return data;
}

async function fetchProvinceList(budget, serviceKey, province) {
  const results = [];
  let pageNo = 1;
  const numOfRows = 100;
  let totalCount = Infinity;

  while ((pageNo - 1) * numOfRows < totalCount) {
    const data = await callApi(budget, 'getParmacyListInfoInqire', {
      serviceKey, Q0: province, pageNo, numOfRows,
    });
    const items = extractItems(data);
    totalCount = extractTotalCount(data) || items.length;
    results.push(...items);
    console.error(`[${province}] 목록 page ${pageNo} (${items.length}건, 누적 ${results.length}/${totalCount}, API 호출 ${budget.used}/${budget.max})`);
    pageNo++;
    await new Promise((r) => setTimeout(r, 150));
  }
  return results;
}

// dutyTime 필드는 계정/항목에 따라 문자열("0900")로도, 숫자(1830)로도 온다.
// 항상 4자리 0패딩 문자열로 정규화한 뒤 다룬다.
function normTime(t) {
  if (t === undefined || t === null || t === '') return null;
  const s = String(t).padStart(4, '0');
  return /^\d{4}$/.test(s) ? s : null;
}

// dutyTime 필드에서 서비스 플래그를 추정한다. 필드가 아예 없으면(구버전 응답 등) null로 남겨
// 프론트엔드가 "정보 없음"으로 처리하게 한다.
function deriveHoursFlags(item) {
  const day = (n) => ({ s: normTime(item[`dutyTime${n}s`]), c: normTime(item[`dutyTime${n}c`]) });
  const weekdays = [1, 2, 3, 4, 5, 6, 7].map(day);
  const holiday = day(8);

  const hasAny = weekdays.some((d) => d.s || d.c);
  if (!hasAny && !holiday.s && !holiday.c) return null;

  const isAllDay = (d) => d.s === '0000' && (d.c === '2400' || d.c === '0000');
  const closesLate = (d) => d.c && parseInt(d.c, 10) >= 2200;

  const is24h = weekdays.some(isAllDay);
  const nightService = is24h || weekdays.some(closesLate);
  const holidayOpen = !!(holiday.s || holiday.c);
  const open365 = weekdays.every((d) => d.s && d.c) && holidayOpen;

  // 대표 평일(월요일, 없으면 첫 영업일) 시간을 기본 표시 시간으로 사용
  const mon = weekdays.find((d) => d.s && d.c) || weekdays[0];
  const fmt = (t) => (t ? `${t.slice(0, 2)}:${t.slice(2)}` : '09:00');

  return {
    is24h,
    open: is24h ? '00:00' : fmt(mon.s),
    close: is24h ? '24:00' : fmt(mon.c),
    open365, nightService, holidayOpen,
  };
}

async function fetchDetail(budget, serviceKey, hpid) {
  const data = await callApi(budget, 'getParmacyBassInfoInqire', { serviceKey, HPID: hpid });
  const items = extractItems(data);
  return items[0] || null;
}

// 일반/대형/창고형 분류 기준(앱 자체 기준 - 법적 기준 아님): 70평(231㎡) / 300평(991㎡)
const LARGE_MIN_AREA = 231;
const WAREHOUSE_MIN_AREA = 991;
function classifySizeTier(area, manualTier) {
  if (typeof area === 'number' && area > 0) {
    if (area >= WAREHOUSE_MIN_AREA) return 'warehouse';
    if (area >= LARGE_MIN_AREA) return 'large';
    return 'general';
  }
  return manualTier || 'general'; // 면적 데이터 없으면 수동 등급(service-overrides.json) 사용, 없으면 일반약국
}

function buildStoreRecord(item, overrides) {
  const hpid = item.hpid;
  const lat = parseFloat(item.wgs84Lat);
  const lng = parseFloat(item.wgs84Lon);
  if (!lat || !lng) return null;

  const hours = deriveHoursFlags(item) || { is24h: false, open: '09:00', close: '20:00', open365: false, nightService: false, holidayOpen: false };
  const override = overrides[hpid] || {};
  const area = typeof override.area === 'number' ? override.area : null;

  return {
    id: `ph_${hpid}`,
    name: item.dutyName,
    lat, lng,
    address: item.dutyAddr || '',
    phone: item.dutyTel1 || null,
    area, // 행정안전부 전국약국표준데이터 기준 영업면적(㎡). 모르면 null.
    sizeTier: classifySizeTier(area, override.sizeTier), // 'general' | 'large' | 'warehouse' - area가 있으면 자동 계산
    hours,
    services: {
      parking: override.services?.parking ?? null,
      driveThrough: override.services?.driveThrough ?? null,
      prescription: override.services?.prescription ?? true, // 약국은 기본적으로 조제 가능하다고 가정
      healthFunctionalFood: override.services?.healthFunctionalFood ?? null,
      medicalDevice: override.services?.medicalDevice ?? null,
      bloodPressure: override.services?.bloodPressure ?? null,
      bloodSugar: override.services?.bloodSugar ?? null,
    },
    items: override.items ?? [],
  };
}

function writeOutputs(byProvince) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // 기존에 저장된 다른 시/도 파일들(이번 실행에서 손대지 않은 곳)을 살리기 위해 기존 index를 불러와 병합.
  const existingIndex = loadJsonSafe(path.join(OUT_DIR, 'index.json'), []);
  const indexByProvince = new Map(existingIndex.map((e) => [e.province, e]));
  const moiByProvince = loadJsonSafe(MOI_STANDALONE_FILE, {}); // 시/도 -> moi_ 단독 등록 약국 배열

  for (const [province, egenStores] of byProvince.entries()) {
    // E-Gen에서 새로 받은 약국 + 행안부 단독 등록 약국(moi_)을 합쳐 저장한다.
    const moi = moiByProvince[province] || [];
    const stores = egenStores.concat(moi);
    if (stores.length === 0) continue;
    const fileName = `${province}.json`;
    fs.writeFileSync(path.join(OUT_DIR, fileName), JSON.stringify(stores), 'utf-8');
    const lats = stores.map((x) => x.lat), lngs = stores.map((x) => x.lng);
    indexByProvince.set(province, {
      province, file: fileName, count: stores.length,
      centerLat: lats.reduce((s, x) => s + x, 0) / stores.length,
      centerLng: lngs.reduce((s, x) => s + x, 0) / stores.length,
      // 프론트엔드가 위치→시/도 판별 시 중심점 거리 대신 실제 좌표범위 포함 여부를 우선 쓰도록 지원
      minLat: Math.min(...lats), maxLat: Math.max(...lats),
      minLng: Math.min(...lngs), maxLng: Math.max(...lngs),
    });
  }
  const index = [...indexByProvince.values()];
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 2), 'utf-8');
  return index;
}

async function run() {
  const serviceKey = process.env.EGEN_API_KEY;
  if (!serviceKey) {
    console.error('EGEN_API_KEY 환경변수가 필요합니다. https://www.data.go.kr/data/15000576/openapi.do 에서 발급받으세요.');
    process.exit(1);
  }

  const cache = loadJsonSafe(CACHE_FILE, { detail: {}, doneProvinces: [], cycleComplete: true });
  cache.detail = cache.detail || {};
  cache.doneProvinces = cache.doneProvinces || [];
  // 하루 1회 정기 실행을 전제로 함: 지난 실행이 끝까지 완료됐다면(cycleComplete) 이번이 "새 하루"이므로
  // doneProvinces를 비우고 처음부터 다시 받아 새로 생긴 약국·바뀐 운영시간을 반영한다.
  // 지난 실행이 할당량 초과 등으로 중간에 멈췄을 때만(cycleComplete=false) 이어서 진행한다.
  if (cache.cycleComplete) cache.doneProvinces = [];
  cache.cycleComplete = false;
  const overrides = loadJsonSafe(OVERRIDES_FILE, {}); // hpid -> { services, items } 수동 큐레이션
  const closedIds = new Set(loadJsonSafe(CLOSED_IDS_FILE, [])); // 폐업 판정된 ph_ id (E-Gen이 아직 들고 있어 제외 필요)

  const budget = new ApiCallBudget(MAX_API_CALLS);
  const byProvince = new Map();
  let stopped = false;

  for (const province of PROVINCES) {
    if (cache.doneProvinces.includes(province)) {
      console.error(`[${province}] 이미 완료됨 - 건너뜀`);
      continue;
    }

    const stores = [];
    try {
      const listItems = await fetchProvinceList(budget, serviceKey, province);

      for (const item of listItems) {
        const hpid = item.hpid;
        if (!hpid) continue;

        // 목록 응답에 좌표·운영시간이 이미 포함되어 있어 보통은 추가 호출이 필요 없다.
        // 드물게 좌표가 빠진 항목만 상세 조회로 보완한다(캐시해서 같은 곳은 다시 안 부름).
        let source = item;
        if (!item.wgs84Lat || !item.wgs84Lon) {
          let detail = cache.detail[hpid];
          if (!detail) {
            detail = await fetchDetail(budget, serviceKey, hpid);
            if (detail) cache.detail[hpid] = detail;
            await new Promise((r) => setTimeout(r, 150));
          }
          if (detail) source = { ...item, ...detail };
        }

        const store = buildStoreRecord(source, overrides);
        if (store && !closedIds.has(store.id)) stores.push(store); // 폐업 판정 id는 제외
      }

      cache.doneProvinces.push(province); // 이 시/도는 처리 완료
      byProvince.set(province, stores);
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        console.error(`API 호출 할당량(${MAX_API_CALLS}건)을 모두 사용했습니다. [${province}]는 다음 실행에서 처음부터 이어집니다.`);
        if (stores.length > 0) byProvince.set(province, stores); // 부분 결과라도 저장(다음 실행에서 어차피 덮어씀)
        stopped = true;
        break;
      }
      console.error(`[${province}] 처리 중 오류:`, e.message);
    }

    saveJson(CACHE_FILE, cache); // 시/도 단위로 캐시 저장(중간에 중단돼도 진행 유지)
  }

  // 17개 시/도 전체가 다 끝나야 "이번 하루치 사이클 완료"로 본다(SYNC_PROVINCES로 일부만
  // 테스트 실행한 경우는 완료로 치지 않음 - 다음 정식 실행이 나머지를 마저 처리하게 둔다).
  cache.cycleComplete = !stopped && ALL_PROVINCES.every((p) => cache.doneProvinces.includes(p));

  const index = writeOutputs(byProvince);
  saveJson(CACHE_FILE, cache);

  console.error(`이번 실행 API 호출 ${budget.used}/${budget.max}건 사용. 완료된 시/도 ${cache.doneProvinces.length}/${ALL_PROVINCES.length}개.`);
  console.error(`전체 저장된 약국 ${index.reduce((s, p) => s + p.count, 0)}개 (${OUT_DIR})`);
  if (cache.cycleComplete) {
    console.error('전국 처리 완료. 다음 실행 때는 최신 정보로 처음부터 다시 받아옵니다.');
  } else {
    console.error('아직 처리 못한 시/도가 남아있습니다. 스크립트를 다시 실행하면 이어서 진행됩니다(할당량은 매일 초기화).');
  }
}

run();
