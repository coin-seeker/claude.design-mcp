# claude.ai/design 모델 매핑

## 결론

2026-07-24 라이브 세션에서 claude.ai/design은 모델 UI 셀렉터를 제공하며, 선택값을 `Chat` 요청 내부 JSON의 `model` 필드로 전송한다. 따라서 MCP의 모델 지정은 **요청 페이로드 주입이 아니라 UI 셀렉터 클릭**으로 구현하는 것이 맞다.

- 프로젝트 화면 selector: `button[title="Change model"]`
- 모델 항목: `[role="menuitemradio"]`
- 기존 대화에서 모델 변경 시 확인: `[data-testid="confirm-dialog-confirm"]`
- 네이티브 `<select>` 및 `[data-testid*="model"]`: 발견되지 않음
- 요청 endpoint: `...OmeletteService/Chat`
- 요청 body: gzip 압축된 Connect/Protobuf framing 내부 JSON

## 실측 매핑

| Anthropic 모델 ID | claude.ai/design UI | `Chat` body의 내부 표현 | 상태 |
| --- | --- | --- | --- |
| `claude-opus-4-8` | `Opus 4.8` | `"model": "claude-opus-4-8"` | UI 선택 및 요청 캡처 완료 |
| `claude-sonnet-5` | `Sonnet 5` | `"model": "claude-sonnet-5"` | UI 선택 및 요청 캡처 완료 |
| 미확인 | `Fable 5` | 미캡처 | UI 노출만 확인 |
| 미확인 | `Haiku 4.5` | 미캡처 | UI 노출만 확인 |

`Opus 4.8`과 `Sonnet 5` 모두 `Medium` effort로 전송했다. 현재 매핑은 날짜 suffix가 붙은 Anthropic API snapshot ID가 아니라 claude.ai/design이 실제 전송한 문자열을 그대로 기록한 것이다.

## 조사 절차

1. `node src/server.mjs list`로 기존 로그인 세션을 확인했다. 별도 로그인이나 계정 변경은 하지 않았다.
2. API 목록의 첫 프로젝트 `aaaa`(`e9c1af24-4a4a-44af-a871-1dc8b1186ce3`)를 UI 링크의 `click()`으로 열었다.
3. 프로젝트 composer에서 모델 메뉴를 열고 option label과 `aria-checked` 상태를 수집했다.
4. 모델 변경 확인 dialog를 승인한 뒤 파일을 수정하지 말라는 짧은 probe prompt를 전송했다.
5. `page.on('request', ...)`에서 `Chat`/`RenewTurn` POST를 감시하고 gzip 및 Connect/Protobuf framing을 해제해 내부 JSON을 저장했다.

짧은 probe turn은 빠르게 종료되어 `RenewTurn`은 발생하지 않았고, 각 실행에서 `Chat` 요청 1건을 캡처했다. 두 요청 모두 응답 메시지에서 디자인 파일을 변경하지 않았음을 확인했다.

## 조작 방법

T2는 다음 순서의 UI 조작으로 구현한다.

1. `button[title="Change model"]`을 클릭한다.
2. 요청된 UI label과 일치하는 `[role="menuitemradio"]`를 클릭한다.
3. `[data-testid="confirm-dialog-confirm"]`이 나타나면 `Switch model`을 클릭한다.
4. 버튼 text가 요청 모델로 바뀐 것을 확인한 뒤 prompt를 전송한다.
5. 지원하지 않는 모델은 경고와 함께 기본 모델을 유지한다.

요청 body 직접 주입은 선택하지 않는다. body가 단순 JSON POST가 아니라 gzip + Connect/Protobuf framing이며, UI가 모델 변경 확인 및 대화 재읽기 상태까지 관리하기 때문이다. 현재 DOM selector가 라이브에서 동작했고, 결과 `Chat` body의 `model` 값도 선택과 일치했다.

## Evidence

Evidence root: `../theseeker/.omo/evidence/claude-design-revival/T1/`

- `model-selector-opus-4-8.png`: 프로젝트 composer의 `Opus 4.8` 선택 및 전체 모델 메뉴
- `request-payloads-opus-4-8.json`: `model = claude-opus-4-8`인 해제된 `Chat` payload
- `model-selector-sonnet-5.png`: 프로젝트 composer의 `Sonnet 5` 선택 및 전체 모델 메뉴
- `request-payloads-sonnet-5.json`: `model = claude-sonnet-5`인 해제된 `Chat` payload
- `blocked-overlay.png`: 기존 대화에서 모델 변경 시 나타나는 `Switch model?` 확인 dialog
- `landing-model-selector.png`: `/design` landing 화면의 기본 `Opus 4.8` 모델 메뉴

재현 명령:

```bash
node scripts/probe-model-selector.mjs
CLAUDE_DESIGN_PROBE_MODEL="Sonnet 5" node scripts/probe-model-selector.mjs
```

`CLAUDE_DESIGN_EVIDENCE_DIR`로 evidence 출력 경로를 바꿀 수 있다.
