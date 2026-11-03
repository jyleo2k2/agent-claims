# 개발 경위와 원본

## 출발점

- 원본 프로젝트: [jyleo2k2/six-opening](https://github.com/jyleo2k2/six-opening)
- 기준 커밋: [`a7d50c6bd564008dbc7b6d7bdcce5091553241b9`](https://github.com/jyleo2k2/six-opening/tree/a7d50c6bd564008dbc7b6d7bdcce5091553241b9)
- 원본 구현: [scripts/git-session-manager.mjs](https://github.com/jyleo2k2/six-opening/blob/a7d50c6bd564008dbc7b6d7bdcce5091553241b9/scripts/git-session-manager.mjs)
- 원본 검증: [scripts/git-session-manager.test.mjs](https://github.com/jyleo2k2/six-opening/blob/a7d50c6bd564008dbc7b6d7bdcce5091553241b9/scripts/git-session-manager.test.mjs)
- 독립 버전 개발 시작: 2026-11-03

원본은 6인 팀 프로젝트에서 Claude·Codex 세션을 브랜치·worktree·파일 선점·PR로 분리하기 위해 사용한 개발 하네스입니다. 원본 프로젝트의 완성 결과와 이 독립 버전의 사용 실적은 구분합니다.

## 이어받은 판단

1. 파일 하나뿐 아니라 부모·자식 디렉터리의 겹침도 선점 충돌로 처리합니다.
2. 연결된 worktree가 공유하는 Git 메타데이터에 상태를 둡니다.
3. 배타적 잠금 안에서 Git·상태 변경을 진행하고 임시 파일의 rename으로 registry를 교체합니다.
4. 작업 규칙을 읽는 것에 더해 실제 변경 파일을 검사합니다.

## 독립화하며 바꾼 것

| 원본의 제약·역할 | 이번 변경과 이유 |
|---|---|
| AI 종류·팀원 이름·한글 작업명이 고정 | 도구·작업자 구분 없는 세션 ID로 생성. 다른 팀과 수동 개발에도 같은 핵심 사용 |
| 특정 프로젝트의 경로·파일 소유권·개발 서버·PR 관리 | 세션 생성·범위 선점·검사·해제로 범위를 줄임 |
| 원격 main fetch와 GitHub CLI 사용 | 로컬 커밋을 기준으로 동작. 초기 커밋 이후에는 원격·로그인 없이 시험 가능 |
| claim이 겹쳐도 실제 변경 파일에 따라 경고로 완화 | 독립 버전은 선점 범위가 겹치면 차단. 이후 편집될 가능성까지 같은 규칙으로 다루기 위함 |
| 자동 훅 설치·정리 명령 포함 | 훅은 수동 연결. 종료는 선점 해제까지이며 파일·브랜치·worktree 보존 |
| JavaScript 단일 스크립트 | 엄격한 TypeScript 세션 모델과 작은 CLI 진입점으로 분리. 외부 JSON은 런타임 검증 |

원본의 코드와 설계에 기반해 AI 코딩 도구와 함께 독립 버전을 작성했습니다. 이 저장소의 생성일을 원본 도구의 개발 시작일로 제시하지 않으며, 다른 팀·사용자의 채택이나 생산성 향상 수치는 아직 주장하지 않습니다.

## 재현할 수 있는 확인

`npm test`의 각 사례는 별도 Git 저장소와 worktree를 만들어 실행합니다. 동시 프로세스가 동일 범위를 선점할 때 하나만 성공하는지, 서로 다른 범위라면 두 상태가 모두 남는지 확인합니다. 실패 fixture는 `.test-artifacts/`에 보존합니다.

원본에 공개 라이선스 파일은 확인되지 않았습니다. 이 독립 버전은 `UNLICENSED`, npm 공개 배포 비활성화 상태로 시작합니다.
