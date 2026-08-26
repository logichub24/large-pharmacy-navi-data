# large-pharmacy-navi-data

`large-pharmacy-navi`가 읽는 전국 약국 데이터 스냅샷입니다.

GitHub Actions가 매일 02:25 KST(17:25 UTC)에 공공데이터 API를 갱신합니다. `EGEN_API_KEY`는 GitHub Actions secret으로만 설정하며 저장소에 커밋하지 않습니다.

동기화는 최대 900회 API 호출로 제한하고, 중단 시 다음 실행에서 남은 시·도부터 이어갑니다.
