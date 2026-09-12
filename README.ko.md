<p align="center">
  <img src="docs/assets/banner.svg" alt="devin-bridge — 모델 직접 호출, 조용한 모델 대체 없음" width="880">
</p>

<p align="center"><strong>Devin 모델을 로컬 OpenAI 호환 채팅·함수 도구 API로 사용한다.</strong></p>

<p align="center">
  <a href="prototype/package.json"><img src="https://img.shields.io/badge/runtime-Bun%201.4.1-b57920?style=flat-square" alt="Bun 1.4.1에서 검증"></a>
  <a href="prototype/src/http.ts"><img src="https://img.shields.io/badge/API-Chat%20Completions-1f6f78?style=flat-square" alt="Chat Completions API"></a>
  <a href="#현재-제약"><img src="https://img.shields.io/badge/status-prototype-9f4d2e?style=flat-square" alt="프로토타입"></a>
</p>

<!-- README-I18N:START -->

[English](./README.md) | **한국어**

<!-- README-I18N:END -->

**devin-bridge**는 Devin 내부 Connect/protobuf 추론 인터페이스를 연결하는
로컬 채팅·함수 도구 프록시다. Devin CLI나 ACP 에이전트를 실행하지 않고 Chat Completions를
제공한다. 실제 `swe-2-medium` 요청을 HTTP 프록시로 보내 **6.52초** 만에 `OK`를
받았다. 정확한 모델 선택, 툴콜, 스트리밍, 오류 처리를 회귀 테스트로 검증한다.
검증된 프로토타입이며 OpenAI API 전체를 대체하는 제품은 아니다.
측정 내용과 한계는 [검증 기록](docs/VERIFICATION.md)에 정리했다.

[기능](#기능) · [설치](#설치) · [사용법](#사용법) · [프로토콜](#동작-원리) · [검증](#검증) · [출처](#출처) · [제약](#현재-제약)

## 기능

- **추론 직접 호출.** 고정 버전의 [oh-my-pi 와이어 선언](prototype/vendor/SOURCE.md)으로 Devin의 Connect/protobuf 인터페이스를 호출한다. CLI 자식 프로세스나 에이전트 루프가 없다.
- **JSON·SSE·네이티브 함수 도구.** `POST /v1/chat/completions`에서 도구 인자 스트리밍, 호출 ID에 연결된 도구 결과, 업스트림 토큰 사용량을 제공한다.
- **SWE-2 추론 수준.** `swe-2` 하나로 표시하고 `reasoning_effort`에 따라 사용 가능한 medium/high/max 변형을 정확히 선택한다.
- **모델 폴백 없음.** 모델·전송 계층의 자동 재시도를 하지 않는다. 업스트림 거부를 다른 모델 호출로 숨기지 않고 그대로 알린다.
- **로컬 접근 통제.** `127.0.0.1`에 바인딩하고 별도의 클라이언트 API 키를 검사하며 브라우저 Origin이 있는 요청을 거부한다.
- **잘못된 스트림은 실패 처리.** 손상되거나 잘린 Connect 응답과 보고된 모델 불일치를 성공으로 처리하지 않는다.

## 설치

**Bun**이 필요하며 설치와 검증은 **Bun 1.4.1**에서 수행했다.
실행 패키지는 `prototype/`에 있다.

```sh
git clone https://github.com/yelixir-dev/devin-bridge.git
cd devin-bridge/prototype
bun install --frozen-lockfile
```

본인 계정의 유효한 Devin 세션 토큰을 사용한다. 현재는 토큰 기반 인증이며,
프로토타입이 브라우저 OAuth를 수행하지는 않는다.

지원하는 자격증명 입력 방법은 두 가지다.

1. `DEVIN_BRIDGE_TOKEN`을 직접 설정한다.
2. 설정하지 않으면 `$XDG_DATA_HOME/devin/credentials.toml`, 기본적으로는
   `~/.local/share/devin/credentials.toml`에 있는 기존 토큰을 읽는다.
   파일만 읽으며 CLI를 실행하지 않는다.

토큰을 직접 입력하려면 다음 Bash 명령을 사용한다.
입력한 값은 셸 기록에 남지 않는다.

```sh
read -rsp "Devin session token: " DEVIN_BRIDGE_TOKEN; printf '\n'
export DEVIN_BRIDGE_TOKEN
```

기존 자격증명 파일을 사용한다면 위 명령은 건너뛴다.
이어서 별도의 로컬 클라이언트 키를 만들고 서버를 시작한다.

```sh
export DEVIN_BRIDGE_API_KEY="$(bun -e 'console.log(crypto.randomUUID())')"
printf 'Local client key: %s\n' "$DEVIN_BRIDGE_API_KEY"
bun run start
```

로컬 클라이언트 키는 Devin 세션 토큰과 **다르다**. 아래 클라이언트 예제에서
사용할 수 있도록 보관한다. 서버 주소는 `http://127.0.0.1:8787`이며 Ctrl-C로 종료한다.

## 사용법

다른 Bash 터미널에서 서버 시작 시 출력된 **동일한 로컬 클라이언트 키**를 입력한다.

```sh
read -rsp "Local client key: " DEVIN_BRIDGE_API_KEY; printf '\n'
export DEVIN_BRIDGE_API_KEY

curl -sS http://127.0.0.1:8787/health

curl -sS http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $DEVIN_BRIDGE_API_KEY"

curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $DEVIN_BRIDGE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"swe-2","reasoning_effort":"high","messages":[{"role":"user","content":"Reply with exactly: OK"}],"max_tokens":128,"stream":true,"stream_options":{"include_usage":true}}'
```

`GET /v1/models`가 반환한 ID를 사용한다. 사용 가능한 모델은 계정에 따라 다르다.
기존 `swe-2-medium` 기준 호출에서 받은 응답 텍스트는 다음과 같다.

```text
OK
```

스트림은 `data: [DONE]`으로 정상 종료했고 **입력 472토큰 / 출력 34토큰**을 보고했다.
단일 호출 관측값이므로 지연 시간 보장이나 벤치마크는 아니다.
`stream`을 `false`로 설정하면 JSON 응답 하나를 받는다.

| 엔드포인트 | 인증 | 결과 |
| --- | --- | --- |
| `GET /health` | 없음 | 로컬 서비스 상태, 브리지 `version`, 전송 방식 |
| `GET /v1/models` | 클라이언트 Bearer 키 | 활성 모델 목록. SWE-2 변형은 하나로 통합 |
| `POST /v1/chat/completions` | 클라이언트 Bearer 키 | JSON 또는 SSE 텍스트·함수 도구 응답 |

허용하는 요청 필드는 `model`, `reasoning_effort`, `messages`, `stream`,
`max_tokens`, `max_completion_tokens`, `temperature`, `stop`, `n:1`,
`stream_options.include_usage`, `store: false`, `tools`, `tool_choice`,
`parallel_tool_calls`다. Content는 문자열 또는 `type: "text"` 블록 배열을
받으며, 블록은 공백을 바꾸지 않고 순서대로 이어 붙인다.
`system`, `user`, `assistant`, `tool`과 함께 `developer` 역할도 지원한다.
도구를 호출하는 assistant 메시지는 content가 null이거나 생략될 수 있다.
다른 필드는 조용히 무시하지 않고 400으로 거부한다.

`max_completion_tokens`는 `max_tokens`의 별칭이며 두 필드 모두 1–65536을 받는다.
둘 다 지정하면 값이 같아야 한다. 둘 다 없으면 한도는 512다.
이미지·오디오 블록과 `store: true`는 여전히 미지원이며 400을 반환한다.
OmO/pi-ai의 정상 텍스트 블록 요청은 클라이언트에서 평탄화할 필요가 없다.
텍스트 블록의 캐시 힌트는 업스트림으로 전달하지 않는다.

### SWE-2 추론 수준

| 요청 | 실제 업스트림 모델 |
| --- | --- |
| `model: "swe-2"`, `reasoning_effort: "medium"` | `swe-2-medium` |
| `model: "swe-2"`, `reasoning_effort: "high"` | `swe-2-high` |
| `model: "swe-2"`, `reasoning_effort: "max"` | `swe-2-max` |
| 추론 수준 없는 `model: "swe-2"` | `swe-2-high` |

기본값은 **high**로 고정하며, 가용성에 따라 다른 레벨로 폴백하지 않는다.
선택한 변형이 없으면 404, 잘못되거나 충돌하는 추론 수준은 400을 반환한다.
모델 목록에서는 하나로 묶지만 기존 변형 ID 직접 호출도 유지한다.
다른 모델에 자동 추론 수준 라우팅을 적용하지 않는다.

통합된 모델 항목에는 확장 필드 `reasoning_efforts`와, high가 사용 가능할 때
`default_reasoning_effort`가 포함된다. 클라이언트는 여전히 `reasoning_effort`를
보내야 하며 이 메타데이터만으로 선택 UI가 자동 생성되지는 않는다.
JSON·SSE 응답의 `model` 값은 **실제로 선택한 변형**을 표시한다.

### 함수 도구

OpenAI 함수 정의를 보내고 `tool_choice`로 `auto`, `none`, `required` 또는
특정 함수를 선택한다. 병렬 호출은 `parallel_tool_calls: true`로 켜며 기본값은 false다.

```json
{
  "model": "swe-2",
  "reasoning_effort": "high",
  "messages": [{"role": "user", "content": "Use add_numbers to add 17 and 25."}],
  "tools": [{
    "type": "function",
    "function": {
      "name": "add_numbers",
      "description": "Add two integers",
      "parameters": {
        "type": "object",
        "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}},
        "required": ["a", "b"],
        "additionalProperties": false
      },
      "strict": true
    }
  }],
  "tool_choice": "required",
  "stream": true
}
```

SSE에서는 `delta.tool_calls`, JSON에서는 `message.tool_calls`를 읽는다.
완료 시 `finish_reason: "tool_calls"`를 반환한다. 인자 조각은 일정한 `index`를
기준으로 합치며, 새 호출에는 `id`와 함수 이름이 포함된다.

브릿지는 미선언·금지된 네이티브 호출, 지정한 이름과 다른 호출,
업스트림 파서 오류·커스텀 페이로드, 불완전한 JSON, 호출과 종료 사유의 불일치를
`invalid_tool_call`로 거부한다. `required` 또는 특정 이름을 요청했는데
네이티브 호출 없이 정상 `stop`으로 끝나도 실패 처리한다.
JSON 오류는 502이며, 이미 열린 SSE 응답은 `[DONE]` 없이 오류를 전달한다.
스트리밍 호출은 유효한 종료 결과를 확인한 뒤 실행해야 한다.
업스트림 길이·콘텐츠 필터 중단을 가짜 호출로 바꾸지는 않는다.

XML 텍스트를 실행 가능한 호출로 승격하지 않으며, `auto`나 `none`에서는
텍스트로 유지한다. 네이티브 인자 문자열은 제어문자와 리터럴 이스케이프를 포함해
바이트를 보존한다. 업스트림이 만든 문법상 유효하지만 의미가 틀린 JSON 문자열은
브릿지가 판별하거나 복원할 수 없으며, 인자를 일괄 언이스케이프하지 않는다.
관측된 문자열 보존 실패와 한계는 [검증 기록](docs/VERIFICATION.md)에 정리했다.

**함수 실행은 클라이언트가 담당한다.** 응답의 `tool_calls`를 보존한 assistant
메시지를 대화 기록에 넣고, 같은 호출 ID의 `tool_call_id`와 결과 `content`를 담은
`role: "tool"` 메시지를 추가한다. 이 기록으로 다음 응답을 요청한다.
미처리 호출마다 연결된 결과 하나가 필요하며, 연결되지 않거나 누락된 결과는
추론 전에 거부한다.

`strict: true`로 선언한 도구는 선언한 JSON Schema를 기준으로 검사한다.
`type`, `required`, `enum`, `const`, `properties`,
`additionalProperties: false`, `items`, 길이·범위 제한, `anyOf`/`oneOf`/`allOf`를
위반하는 인자는 그대로 전달하지 않고 `invalid_tool_call`로 실패 처리한다.
알 수 없는 스키마 키워드는 위반으로 보지 않고 무시한다. strict가 아닌 도구는
OpenAI 의미 그대로 인자를 변경 없이 전달한다. JSON과 SSE는 하나의 완료 검증기를
공유하므로, 종료 이벤트 없이 끝난 스트림은 두 표면 모두 `protocol_error`가 되고
업스트림의 줄 수 제한 종료는 `finish_reason: "length"`로 보고한다.

요청 본문은 **16 MB**까지 받으므로 262k 토큰 컨텍스트에 가까운 대화도 거부되지 않는다.
그보다 큰 본문은 추론 전에 413을 반환한다.
업스트림 스트림은 **120초** 동안 아무 프레임도 오지 않을 때만 중단한다(`deadline_exceeded`).
고정된 총 시간 제한이 없으므로 프레임을 계속 보내는 긴 생성은 브리지가 끊지 않는다.
클라이언트가 연결을 닫으면 업스트림 요청도 취소된다.
모든 응답과 SSE 청크에는 `system_fingerprint: "devin-bridge-<version>"`이 포함된다
(`prototype/package.json`의 version). 중간 프록시를 거쳐도 어떤 빌드가 응답했는지
확인할 수 있다.

| 환경변수 | 필수 여부 | 동작 |
| --- | --- | --- |
| `DEVIN_BRIDGE_API_KEY` | 필수 | 로컬 클라이언트 키. 16자 이상 |
| `DEVIN_BRIDGE_TOKEN` | 자격증명 파일을 읽지 않을 때 필수 | 업스트림 Devin 세션 토큰 |
| `DEVIN_BRIDGE_API_URL` | 선택 | 업스트림 기본 URL 직접 지정 |
| `XDG_DATA_HOME` | 선택 | 기존 자격증명 파일의 기준 디렉터리 |
| `PORT` | 선택 | 로컬 포트. 기본값 `8787` |

직접 지정한 `DEVIN_BRIDGE_TOKEN`이 자격증명 파일보다 우선한다.
이 토큰을 지정하고 URL을 별도로 설정하지 않으면
`https://server.codeium.com`을 사용한다. 파일을 읽는 경우에는
파일의 `api_server_url`을 사용할 수 있다.

## 동작 원리

1. 세션 토큰을 읽고 `GetCliModelConfigs`로 계정의 모델 목록을 조회한다.
2. 요청을 검증하고 SWE-2 추론 수준을 정확한 활성 모델 ID로 해석한다. 라우터 모델은 허용하지 않는다.
3. `GetUserJwt`로 사용자 JWT를 얻는다. 브라우저나 CLI를 시작하지 않는다. JWT는 자격증명별로 캐시하고 `exp` 클레임 1분 전에 갱신하므로(관측된 수명 15분) 동시 요청이 인증 호출 하나를 공유한다.
4. 고정된 protobuf 스키마로 `CASCADE` 요청을 인코딩해 `GetChatMessage`를 호출한다.
5. 텍스트·도구 인자·사용량 이벤트를 해석하면서 보고된 모델 ID를 검사한다.
6. OpenAI 형태의 JSON/SSE를 반환한다. 오류는 전달하고 클라이언트가 연결을 닫으면 추론을 취소한다.

호출자가 요청마다 대화 기록을 전달한다. 브리지가 도구를 실행하거나 로컬 에이전트
작업공간을 만들거나 자식 에이전트를 띄우지는 않는다.

## 검증

`prototype/`에서 공개 전과 동일한 검증을 실행할 수 있다.

```sh
bun run typecheck
bun test tests
bun run build
```

| 검증 항목 | 코드 / 테스트 | 잡아내는 실패 |
| --- | --- | --- |
| 와이어 요청 | [RPC 테스트](prototype/tests/rpc.test.ts) | 잘못된 `GENERAL`/`CASCADE` 요청 구분값 |
| 오류 전달 | [RPC 테스트](prototype/tests/rpc.test.ts) | 잘린 프레임, 잘못된 트레일러, 업스트림 거부, 보고된 모델 대체 |
| HTTP 계약 | [HTTP 테스트](prototype/tests/http.test.ts) | 잘못된 JSON/SSE 응답, 인증 누락, 미지원 입력, 거부 후 재시도 |
| 자격증명 파싱 | [TOML 테스트](prototype/tests/creds.test.ts) | 따옴표가 토큰 값의 일부로 들어가는 오류 |
| SWE-2 추론 수준 | [그룹 테스트](prototype/tests/swe2-effort.test.ts) | 잘못된 변형, 부정확한 목록, 추론 수준 폴백 |
| 함수 도구 | [와이어](prototype/tests/tool-wire.test.ts), [스트림](prototype/tests/tool-output.test.ts), [HTTP](prototype/tests/tool-http.test.ts) | 선언·인자 손실, 불안정한 ID, 끊긴 결과 연결, 도구 전용 응답을 빈 응답으로 거부하는 오류 |

자동 테스트는 로컬 픽스처를 사용하므로 계정 크레딧을 소모하지 않는다.
별도의 [실제 호출 검증 기록](docs/VERIFICATION.md)은 인증된 SWE-2 호출을 다룬다.
조회된 모든 모델을 실행해 봤다는 뜻은 아니다.

## 저장소 구조

```text
prototype/src/         HTTP surface, direct RPC client, credentials
prototype/tests/       Deterministic local regression tests
prototype/vendor/      Pinned oh-my-pi wire code and MIT notice
docs/                 Verification, attribution views, banner
scripts/              Attribution registry renderer
```

## 출처

와이어 선언과 protobuf 코덱은
[oh-my-pi](https://github.com/can1357/oh-my-pi)의
`3b3a6dc9bbd85102ce19d0b1c11bf6870915f6ec` 커밋에서 가져왔으며 MIT 라이선스다.
원 저작권 고지는 [prototype/vendor/LICENSE](prototype/vendor/LICENSE)에 보존했다.
작은 코덱 수정 사항은 [SOURCE.md](prototype/vendor/SOURCE.md)에 기록했다.
업스트림 에이전트 프레임워크나 모델 라우팅 정책은 가져오지 않았다.

출처 목록: [Markdown](docs/ATTRIBUTIONS.md) ·
[HTML](docs/attributions.html) · [JSON 원본](attributions.json).
저장소 루트에서 `bun scripts/build-attributions.mjs`를 실행하면
JSON 원본으로 두 문서를 다시 생성한다.

제삼자 코드에는 원래의 MIT 조건이 적용된다. 이 프로젝트의 라이선스가 해당
조건을 대체하거나 범위를 좁히거나 재허가하지 않는다.
Cognition/Devin 및 출처에 기재된 원저작자는 이 프로젝트를 보증하지 않는다.

## 현재 제약

- **아직 프로토타입:** 이미지, Anthropic Messages 엔드포인트, 대시보드, 대화형 OAuth는 없다. 클라이언트가 함수 도구를 실행하며 유효한 세션 토큰과 연결된 도구 결과를 보내야 한다.
- **비공개 업스트림 인터페이스:** 와이어 동작과 계정별 가용성이 바뀔 수 있다. 업데이트 후 픽스처 테스트와 승인된 소규모 실제 호출로 확인한다.
- **로컬 서비스 전용:** 원격 배포 자동화나 공개 리스너가 없다. 접근을 비공개로 유지하고 클라이언트 키와 업스트림 토큰을 모두 보호한다.
- **계정에 따른 사용량:** 구독 한도와 서비스 약관은 그대로 적용된다. 거부를 우회하려고 다른 모델을 호출하지 않으므로 반환된 오류와 계정 사용량을 확인한다.

## 라이선스

프로젝트 자체 라이선스는 **to be declared** 상태다.
업스트림 와이어 코드에는 별도의 [vendored MIT 라이선스](prototype/vendor/LICENSE)가 적용된다.

<p align="center"><em>devin-bridge · 로컬 텍스트 추론</em></p>
