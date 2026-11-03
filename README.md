---
created: 2026-11-03T13:38
updated: 2026-11-03T17:30
---
# agent-claims

[![CI](https://github.com/jyleo2k2/agent-claims/actions/workflows/ci.yml/badge.svg)](https://github.com/jyleo2k2/agent-claims/actions/workflows/ci.yml)

여러 코딩 세션이 같은 파일을 수정하기 전에 **작업 범위를 선점하는 Git CLI**입니다.

각 세션에 브랜치와 worktree를 만들고, 수정할 파일·디렉터리를 claim합니다. 다른 세션이 선점한 범위와 겹치면 시작을 차단합니다. 사람이 쓰는 세션과 AI 코딩 세션에 같은 규칙을 적용합니다.

```text
my-app/                       main 작업 디렉터리
my-app-sessions/
  ui/                         agents/ui  → src/ui 선점
  api/                        agents/api → src/api 선점

새 세션이 src/ui/Button.tsx 선점 요청 → ui 세션과 충돌하므로 거절
```

## 왜 만들었나

팀 프로젝트에서 서로 다른 AI 도구를 사용하며 작업 규칙을 문서로 공유했습니다. AI가 규칙을 따르지 않는 경우가 있어, 브랜치·worktree·파일 선점을 실행 코드와 훅으로 강제하는 하네스를 만들었습니다.

원본 도구는 팀원 이름과 프로젝트 경로, 개발 서버와 PR 정책까지 한곳에 묶여 있었습니다. 이 저장소에서는 세션 생성·파일 선점·범위 검사를 분리해 다른 Git 저장소에서도 사용할 수 있게 만들었습니다. 원본 코드와 분리 과정은 [PROVENANCE.md](PROVENANCE.md)에 기록했습니다.

## 빠르게 사용하기

Node.js 24 이상과 Git 2.36 이상이 필요합니다. 런타임 외부 패키지, GitHub 로그인, AI API 키는 필요하지 않습니다. 최초 커밋이 있는 일반 Git 저장소에서 사용합니다.

이 저장소에서 설치·검증합니다.

```sh
npm ci
npm test
```

PowerShell 예시입니다. `C:/dev/my-app`은 작업 대상 저장소로 바꿉니다. CLI 경로를 절대 경로로 잡아 두면 새 worktree에서도 같은 명령을 쓸 수 있습니다.

```powershell
$claims = (Resolve-Path ./dist/cli.js).Path
Set-Location C:/dev/my-app

node $claims start ui --path src/ui
node $claims start api --path src/api
node $claims status
```

macOS·Linux에서는 빌드한 CLI의 절대 경로로 실행합니다.

```sh
CLAIMS=/absolute/path/to/agent-claims/dist/cli.js
cd /path/to/my-app
node "$CLAIMS" start ui --path src/ui
```

`start` 결과는 새 worktree의 경로를 포함하는 JSON입니다.

```json
{
  "id": "ui",
  "branch": "agents/ui",
  "worktree": "C:\\dev\\my-app-sessions\\ui",
  "paths": ["src/ui"],
  "status": "active"
}
```

작업은 출력된 worktree에서 진행합니다.

```powershell
Set-Location C:/dev/my-app-sessions/ui

# 수정 전에 제안 경로 확인
node $claims check --path src/ui/Button.tsx

# 범위를 넓히려면 먼저 선점
node $claims claim --path src/shared/ui

# 작업 후 추적·미추적 변경 경로를 검사
node $claims check
```

기본 생성 기준은 명령을 실행한 저장소의 **커밋된 HEAD**입니다. 기준 브랜치를 정하려면 `--base main`처럼 지정합니다. 커밋하지 않은 파일·`.env`·`node_modules`를 복사하지 않습니다. Git에 이미 커밋한 파일은 그대로 포함되므로 비밀정보를 커밋하지 않아야 합니다.

## 명령

| 명령 | 동작 |
|---|---|
| `start <id> --path <경로>... [--base <ref>]` | 겹치는 선점이 없으면 `agents/<id>` 브랜치와 형제 디렉터리의 worktree 생성 |
| `claim --path <경로>...` | 현재 세션의 기존 선점에 경로 추가. 충돌하면 변경 전체 거절 |
| `check [--path <경로>...]` | 추적·미추적 변경과 제안 경로가 현재 세션의 범위 안인지 확인 |
| `release <id>` | 미커밋 변경이 없을 때 선점 해제. 브랜치·커밋·worktree는 유지 |
| `status` | 같은 Git 저장소의 모든 세션 상태 출력 |

`claim`과 `check`는 활성 세션 worktree에서 실행합니다. `start`, `release`, `status`는 같은 저장소의 main 또는 연결된 worktree에서 실행할 수 있습니다. 모든 경로는 현재 하위 디렉터리가 아닌 **저장소 루트 기준**입니다. 여러 경로는 `--path src --path tests`처럼 반복합니다.

세션 ID는 문자·숫자·밑줄·하이픈으로 최대 64자입니다. 한글을 사용할 수 있으며 Windows 예약 장치 이름은 거절합니다. 한 저장소 안에서 사용한 ID는 재사용하지 않습니다. 새 작업에는 새 ID를 지정합니다.

성공하면 JSON과 종료 코드 `0`, 실패하면 stderr 설명과 종료 코드 `1`을 반환합니다.

### 작업 종료

```powershell
node $claims check
git add src/ui
git commit -m "Update UI"
node $claims release ui
```

`release`는 병합하지 않은 커밋도 보존합니다. 병합·정리 여부는 직접 결정합니다. 이 도구에는 브랜치·worktree 삭제, 강제 초기화, 자동 stash 기능이 없습니다.

## 설계와 안전장치

1. **같은 파일을 함께 선점할 수 없습니다.** 파일·부모 디렉터리·자식 디렉터리의 겹침을 검사합니다. `.`은 저장소 전체 선점입니다. Windows에서는 경로 대소문자를 같은 것으로 비교합니다.
2. **worktree가 달라도 상태는 하나입니다.** Git 공용 메타데이터 아래 `agent-claims/state.json`을 사용합니다. 배타적 파일 잠금으로 동시 시작·선점 갱신을 직렬 처리합니다.
3. **실패하면 범위를 열어 주지 않습니다.** 생성 중에는 `starting`으로 먼저 예약합니다. Git 생성에 실패하거나 프로세스가 종료돼도 예약이 남아 다른 세션의 진입을 막습니다. 손상된 상태 파일도 빈 상태로 덮어쓰지 않습니다.
4. **범위 밖 경로를 확인합니다.** 저장소 밖 경로·Git 메타데이터·symlink/junction을 거절합니다. 이름 변경은 이전·새 경로를 모두 검사합니다.

TypeScript의 `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`를 사용합니다. 세션 상태는 `starting | active | released`로 제한하고, 파일에서 읽은 JSON은 `unknown`에서 구조를 확인한 뒤 사용합니다. 명령행은 Node의 `parseArgs`, Git 실행은 셸 문자열 조합 없이 인수 배열을 사용합니다.

### 검사 연결

선점은 협조적인 세션 사이의 작업 규칙입니다. 운영체제의 쓰기 권한을 제한하지 않으므로 `check`를 실행하지 않는 도구의 편집은 막지 못합니다. 자동 강제가 필요하면 사용 중인 AI 도구의 편집 전 훅이나 Git 훅에서 `check`를 호출해야 합니다. 기존 훅 설정은 자동 변경하지 않습니다.

아래는 Git `pre-commit`에 수동으로 연결할 수 있는 예입니다. CLI 경로를 실제 빌드 경로로 바꾸고 기존 훅과 합쳐 사용합니다. `check`는 스테이징된 파일 외에 현재 worktree의 미스테이징·미추적 파일도 검사합니다.

```sh
#!/bin/sh
case "$(git branch --show-current)" in
  agents/*) node "/absolute/path/to/agent-claims/dist/cli.js" check ;;
esac
```

## 실패 복구와 한계

| 상황 | 확인·해결 |
|---|---|
| `Scope conflict` | `status`에서 선점한 세션 확인. 범위를 나누거나 기존 작업을 마친 뒤 해제 |
| `Outside claimed scope` | 해당 경로가 필요한 작업인지 확인하고 `claim --path ...`로 범위 확장 |
| `Start incomplete` / `starting` 상태 | `git worktree list`와 출력 경로의 브랜치·변경 파일 확인 후 `release <id>`. 재시작은 새 ID로 진행 |
| `Registry locked` | 실행 중인 다른 명령이 있는지 확인. 모두 종료된 것이 확인된 경우에만 오류에 표시된 잠금 파일을 수동 복구. 자동으로 잠금을 훔치지 않음 |
| 손상된 registry·사라진 worktree | 상태 파일과 Git worktree 정보를 보존해 원인 확인. 자동 초기화·강제 복구 없음 |

- 한 로컬 저장소와 연결된 worktree 사이에서만 동작합니다. 다른 clone·컴퓨터·열린 GitHub PR의 선점은 공유하지 않습니다.
- Git에 무시된 파일은 `check` 대상에서 제외합니다. 커밋 간 정책 위반을 과거까지 추적하거나 코드의 의미를 검사하지 않습니다.
- symlink/junction 경로는 지원하지 않습니다. 네트워크 파일시스템의 잠금·원자적 rename 동작은 검증 범위 밖입니다.
- 개발 서버·포트 배정·자동 PR·AI 실행·스킬 성능 평가는 포함하지 않습니다.

## 검증과 구조

`npm test`는 TypeScript 빌드 후 Node 기본 테스트 러너로 실제 Git 저장소를 생성해 CLI를 실행합니다. 병렬 프로세스의 중복 선점, 범위 확장 실패의 원자성, 이동 전후 경로, 파일 보존, 손상 상태·생성 실패를 확인합니다.

`.github/workflows/ci.yml`에는 Node 24의 Windows·Ubuntu 실행을 구성했습니다. 원격 CI 통과 여부와 로컬에서 수행한 검증은 구분합니다. fixture는 `.test-artifacts/`에 남아 실패 상태를 직접 확인할 수 있습니다.

2026-11-03 Windows에서 Node 24.14.1·Git 2.54.0으로 실제 Git 저장소의 통합 테스트 14개를 통과했습니다. tarball에 빌드한 JavaScript와 문서만 포함되는지 확인하고, 별도 저장소에 설치한 패키지로 세션을 생성했습니다. 개발 의존성 없이 실행되는 것도 확인했습니다. 같은 날 [GitHub Actions](https://github.com/jyleo2k2/agent-claims/actions/runs/41603485256)에서 Windows·Ubuntu 작업이 모두 통과했습니다(Ubuntu는 Windows 전용 경로 별칭 사례 제외). Git 최소 버전에서의 실행은 확인하지 않았습니다.

```text
src/session.ts              Git·경로·잠금·세션 수명주기
src/cli.ts                  명령 파싱·JSON 출력·종료 코드
test/session.test.mjs        실제 저장소·병렬 프로세스 통합 테스트
.github/workflows/ci.yml     Windows·Ubuntu 테스트와 패키지 구성 검사
PROVENANCE.md               원본 커밋·변경 이유·개발 경위
```

`npm pack`으로 빌드 결과와 문서를 담은 로컬 tarball을 만들 수 있습니다. npm 공개 배포는 하지 않았으며 `private: true`로 비활성화되어 있습니다.
