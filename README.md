# Spearhead Fieldbook

Age of Sigmar: Spearhead 비공식 팬 제작 보조 도구입니다. 전투 준비부터 4라운드 결과까지 안내하고, 카드 덱·점수·전적을 관리합니다.

**사이트: https://spearhead-fieldbook.web.app** (예비 주소: https://swingcrisp.github.io/spearhead-fieldbook/)

Fire and Jade / Sand and Bone / City of Ash 일반 1:1 전투용입니다(Hidden in the Ashes 캠페인 제외).

> 비공식 팬 제작 보조 도구입니다. Games Workshop과 제휴 관계가 없으며, 공식 승인이나 후원을 받은 서비스가 아닙니다.
> An unofficial fan-made companion tool. Not affiliated with, endorsed or sponsored by Games Workshop.

## 자료에 대해

제작자는 스피어헤드 배틀팩 세 가지를 소유하고 있으며, 실물 카드를 참고해 플레이에 필요한 내용을 짧게 요약·정리했습니다. 이 앱은 실물 카드와 공식 규칙을 함께 사용하는 비공식 보조 도구입니다.

- 카드 문구는 한국어·영어 모두 **비공식 요약**입니다. 정확한 문구와 판정은 실물 카드 및 최신 공식 자료를 확인하세요.
- 유물·지형 능력은 해당 배틀팩의 최신 공식 규칙을 확인하세요.
- 카드 설명은 사용자가 제공한 번역 자료를 우선합니다. 최신 공식 Rules Updates는 별도 확인 링크로 제공합니다.
- 군대 선택 목록(연대 능력·강화 이름)은 선택을 돕기 위한 참고용입니다. 목록에 없거나 다르면 직접 입력할 수 있습니다.

## 실행

빌드 도구가 필요 없는 정적 웹앱입니다.

```bash
node serve.js
```

그다음 브라우저에서 http://localhost:5173 을 엽니다. 휴대폰에서 쓰려면 같은 Wi‑Fi에서 `http://<PC의 IP>:5173` 으로 접속하세요.
서버 없이 `dist/index.html`을 더블클릭해서 열어도 작동합니다(카드 데이터가 `cards.js`에 들어 있음).

```bash
npm test            # 엔진·저장소·연결 테스트 (node --test)
npm run build       # data/ 의 JSON 검증 → dist/cards.js 재생성
```

카드 데이터는 `data/spearhead-cards.en-ko.json`, 군대 선택 목록은 `data/spearhead-armies.json`에 있습니다. 수정한 뒤 `npm run build`를 실행하세요.

## 기기 사용 방식

| 방식 | 설명 |
|---|---|
| 각자 폰 · 연결 | 방 코드(또는 공유 링크)로 두 폰을 연결. 점수·라운드·트위스트·되돌리기가 두 폰에 동기화되고, 각 폰에는 자기 카드만 표시 |
| 각자 폰 · 연결 없이 | 내 폰에서 내 덱만 관리. 상대 턴 점수는 총점만 입력. 트위스트는 한 폰에서 뽑고 다른 폰은 목록에서 선택 |
| 한 기기로 둘이 | 한 기기로 두 사람의 덱을 관리. 손패는 가려서 번갈아 보기 |

### 연결 모드 (Firebase Realtime Database, 무료 Spark 요금제)

- 데이터베이스 보안 규칙: `firebase-rules.json`
- 앱 설정: `dist/firebase-config.js` (데이터베이스 주소만 들어 있는 공개 값이며, 접근 제어는 규칙이 담당)
- 방 데이터(손패 포함)는 방 코드를 아는 사람이 읽을 수 있으므로 화면 숨김은 보안 기능이 아닙니다.
- 개발 중에는 `?device=p1&transport=local` / `?device=p2&transport=local` 두 탭으로 Firebase 없이 연결 모드를 시험할 수 있습니다.

## 배포

- Firebase Hosting(주 주소): `npx.cmd firebase-tools deploy --only hosting` — Firebase에 로그인된 PC에서 실행. 설정은 `firebase.json`
- GitHub Pages(예비 주소): `main`에 푸시하면 자동 배포

## 구조

| 파일 | 역할 |
|---|---|
| `dist/engine.js` | 규칙 엔진. 준비 단계, 덱 셔플(Fisher–Yates + crypto), 언더독·주도권 탈취·5점 예외, 손패, 턴 페이즈, 득점, 라운드 종료 |
| `dist/link.js` | 두 폰 연결: 방 코드, compare-and-set 동기화, 공유 되돌리기, Firebase/로컬/메모리 전송 계층 |
| `dist/store.js` | localStorage 저장, 되돌리기 스냅샷, 전적(1회 저장), 손상 데이터 보존, 백업 내보내기/불러오기 |
| `dist/i18n.js` | 한국어/English UI 문자열 |
| `dist/app.js` | 화면. 차근차근 플레이와 빠른 기록이 같은 게임 상태를 공유 |
| `dist/cards.js` | 생성 파일 (`tools/build-cards.js`) |
| `tests/` | 덱·보충·언더독(3팩 × 경계값)·커맨드/택틱 중복·득점·종료·되돌리기·새로고침·준비 분기·두 폰 연결 테스트 |

## 규칙 처리 원칙

- 카드 조건 달성, 커맨드 발동 조건, 트위스트 대상 선택은 앱이 판정하지 않습니다. 플레이어가 확인하고 기록합니다.
- DARKENED SKIES와 INVINCIBLE REDOUBTS는 제공받은 번역 PDF에 명시된 선택 주체·영토 문구를 반영했습니다.
- 페이즈별 커맨드 "후보"는 카드의 타이밍 문구만으로 고른 목록입니다. 사용 가능하다는 판정이 아닙니다.
- 빠른 기록 모드에서 기록하지 않은 페이즈는 "미기록"으로 남깁니다. 완료했다고 기록하지 않습니다.

## 저작권

비상업 팬 도구로 유지합니다. Games Workshop 로고·아트·카드 원문·이미지를 넣지 않고, 광고나 유료화를 하지 않습니다.
