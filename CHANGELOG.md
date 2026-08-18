# Changelog

## [1.4.1](https://github.com/henry753951/volleyball-monitoring-ai/compare/v1.4.0...v1.4.1) (2026-08-17)


### Bug Fixes

* **worker:** recover long VOD ingestion from transient failures ([3733d9c](https://github.com/henry753951/volleyball-monitoring-ai/commit/3733d9c3c508e4f7dc6727f7d7b4f1498ea455eb))

## [1.4.0](https://github.com/henry753951/volleyball-monitoring-ai/compare/v1.3.0...v1.4.0) (2026-08-17)


### Features

* **media:** stream growing captures through hot tier ([b1a6950](https://github.com/henry753951/volleyball-monitoring-ai/commit/b1a695036d20e51e3600e04d610bca8984af7b64))
* **media:** stream growing captures through hot tier ([6c83ee5](https://github.com/henry753951/volleyball-monitoring-ai/commit/6c83ee5ee88d8db3e7941f75a68828f4f3db9fe6))
* **media:** stream growing captures through hot tier ([#96](https://github.com/henry753951/volleyball-monitoring-ai/issues/96)) ([b1a6950](https://github.com/henry753951/volleyball-monitoring-ai/commit/b1a695036d20e51e3600e04d610bca8984af7b64))


### Bug Fixes

* **media:** keep rolling archive playback attached ([bd3c836](https://github.com/henry753951/volleyball-monitoring-ai/commit/bd3c836fc61cf88ad71e72411fca269a7c51e866))


### Documentation

* add single-node k3s operations runbook ([1b4d430](https://github.com/henry753951/volleyball-monitoring-ai/commit/1b4d430683c2f8a2a95cb58b997f465f03635a63))

## [1.3.0](https://github.com/henry753951/volleyball-monitoring-ai/compare/v1.2.0...v1.3.0) (2026-08-17)


### Features

* cap reid gids and bound rerun waits ([#94](https://github.com/henry753951/volleyball-monitoring-ai/issues/94)) ([f83471b](https://github.com/henry753951/volleyball-monitoring-ai/commit/f83471bd059f3fd5ec340b3dc2e9d61f89664698))

## [1.2.0](https://github.com/henry753951/volleyball-monitoring-ai/compare/v1.1.0...v1.2.0) (2026-08-17)


### Features

* checkpoint annotation, reid, and coach workflow updates ([acacc74](https://github.com/henry753951/volleyball-monitoring-ai/commit/acacc748882157f245deee64117f8d04cb4dc12c))
* overhaul annotation and coach workflows ([8c10af0](https://github.com/henry753951/volleyball-monitoring-ai/commit/8c10af095acec81c9a6372c191e84f7214b0e722))
* ship revisioned ReID and resilient annotation workflows ([32194b4](https://github.com/henry753951/volleyball-monitoring-ai/commit/32194b41f6be52f351bf1ca37bd861b56bf399c4))
* ship revisioned ReID and resilient annotation workflows ([700e893](https://github.com/henry753951/volleyball-monitoring-ai/commit/700e893394f9617c3fd0ab1bddd5c6d81209cb8d))

## [1.1.0](https://github.com/henry753951/volleyball-monitoring-ai/compare/v1.0.0...v1.1.0) (2026-08-16)


### Features

* **annotation:** rebuild editing and coach workflows ([039b7ed](https://github.com/henry753951/volleyball-monitoring-ai/commit/039b7ed0af0bbd62d35872c8e1111956aea9a181))
* **annotation:** rebuild editing and coach workflows ([f93fda8](https://github.com/henry753951/volleyball-monitoring-ai/commit/f93fda87b9f9b7c92b65ef043718b998432807ab))

## [1.0.0](https://github.com/henry753951/volleyball-monitoring-ai/compare/v0.8.1...v1.0.0) (2026-08-16)


### ⚠ BREAKING CHANGES

* remove the legacy fixed-roster ReID callbacks, schemas, services, and persistence model in favor of independent provider-work evidence and correction jobs.

### Features

* hard cut ReID and redesign coach replay ([#88](https://github.com/henry753951/volleyball-monitoring-ai/issues/88)) ([946f7a8](https://github.com/henry753951/volleyball-monitoring-ai/commit/946f7a8d2e79c3273e57962e43cfb3f93e2e0738))

## [0.8.1](https://github.com/henry753951/volleyball-monitoring-ai/compare/v0.8.0...v0.8.1) (2026-08-16)


### Bug Fixes

* **coach:** show jersey numbers in replay labels ([#86](https://github.com/henry753951/volleyball-monitoring-ai/issues/86)) ([f8b0de2](https://github.com/henry753951/volleyball-monitoring-ai/commit/f8b0de22b7b25854a6f1ec9cc3bc0ff9b161027c))

## [0.8.0](https://github.com/henry753951/volleyball-monitoring-ai/compare/v0.7.1...v0.8.0) (2026-08-16)


### Features

* **annotation:** add human ball event workflow ([#84](https://github.com/henry753951/volleyball-monitoring-ai/issues/84)) ([6560e10](https://github.com/henry753951/volleyball-monitoring-ai/commit/6560e108f1a71b49f389998af4280ecc713c9419))

## [0.7.1](https://github.com/henry753951/volleyball-monitoring-ai/compare/v0.7.0...v0.7.1) (2026-08-15)


### Bug Fixes

* **sdk:** stabilize provider heartbeat through proxies ([#82](https://github.com/henry753951/volleyball-monitoring-ai/issues/82)) ([f99ba36](https://github.com/henry753951/volleyball-monitoring-ai/commit/f99ba36e2a933008ca69cc0b0bad703cdf9b878f))

## [0.7.0](https://github.com/henry753951/volleyball-monitoring-ai/compare/v0.6.0...v0.7.0) (2026-08-15)


### Features

* **reid:** add versioned evidence and provider work ([#80](https://github.com/henry753951/volleyball-monitoring-ai/issues/80)) ([f0815a3](https://github.com/henry753951/volleyball-monitoring-ai/commit/f0815a3119a9253ab767e4ba160ef6f0d677688f))

## [0.6.0](https://github.com/henry753951/volleyball-monitoring-ai/compare/v0.5.0...v0.6.0) (2026-08-15)


### Features

* **annotation:** make drafts client-owned and resilient ([19ca0fd](https://github.com/henry753951/volleyball-monitoring-ai/commit/19ca0fd3ee05d6a1c9b9602355cd905238aaca0e))
* consolidate v0.6.0 release changes ([6976c41](https://github.com/henry753951/volleyball-monitoring-ai/commit/6976c41eda8315f3452eac6ada286560be712496))


### Bug Fixes

* **coach:** restore completed replay analysis ([449696c](https://github.com/henry753951/volleyball-monitoring-ai/commit/449696c05dd3c787d336092e716230300bdbe509))
* **media:** preserve incomplete ingest failures ([c388aa2](https://github.com/henry753951/volleyball-monitoring-ai/commit/c388aa23855a9303c44892127b06131968b6ec8f))
* **reid:** support clip-only manual assignments ([177b851](https://github.com/henry753951/volleyball-monitoring-ai/commit/177b851db6805119eb6c367638b9b7f12092983f))
* **web:** preserve typed imports and template handlers ([1fbe3a6](https://github.com/henry753951/volleyball-monitoring-ai/commit/1fbe3a6b2a19ebaae7a4c3599e782d0779ac5f42))


### Tests

* **worker:** preserve permanent ingest failure sentinel ([e3b0e83](https://github.com/henry753951/volleyball-monitoring-ai/commit/e3b0e836129e4222ee457cfc13da773e6a639df1))


### Documentation

* **agents:** map architecture and delivery workflow ([40de3b8](https://github.com/henry753951/volleyball-monitoring-ai/commit/40de3b8f7e90038887df49f8df421b417921ca0f))
* **progress:** record resilient annotation editing ([2b7ee85](https://github.com/henry753951/volleyball-monitoring-ai/commit/2b7ee85e1ac99233cee3728b34b930c628aea7a3))


### Maintenance

* **checksums:** refresh repository manifest ([921c0df](https://github.com/henry753951/volleyball-monitoring-ai/commit/921c0dfabfd31f0d043ffd2c935d06b586e21c86))
* **checksums:** refresh web fix manifest ([b1dd79c](https://github.com/henry753951/volleyball-monitoring-ai/commit/b1dd79cacf428dd76e2daaaa49f81c52117cbce0))

## [0.5.0](https://github.com/henry753951/volleyball-monitoring-ai/compare/v0.4.0...v0.5.0) (2026-08-14)


### Features

* **analysis:** adopt AnalysisData v1 workflow ([93f2091](https://github.com/henry753951/volleyball-monitoring-ai/commit/93f2091223a2cd858d6c3a7167fca22f6b2c0893))
* **analysis:** adopt AnalysisData v1 workflow ([a82cbc0](https://github.com/henry753951/volleyball-monitoring-ai/commit/a82cbc05b7e54f0833ae1bb07ee965a7805e0625))
* **coach:** add team-wide player analytics ([bff99ac](https://github.com/henry753951/volleyball-monitoring-ai/commit/bff99acc8305007a2dab82f534664617f3e05954))
* **coach:** add team-wide player analytics ([0345c68](https://github.com/henry753951/volleyball-monitoring-ai/commit/0345c68574a6449ebc36bd162c6fa7ab4fdd4f16))
* integrate coach analytics and fixed-roster ReID ([28c7555](https://github.com/henry753951/volleyball-monitoring-ai/commit/28c75552b86ca7b0711b1d2c495a4714b44bb827))
* manage Local ID and GID player assignments ([de24816](https://github.com/henry753951/volleyball-monitoring-ai/commit/de248160999314a69ab1c249081cf53a2779e24d))
* **reid:** adopt fixed-roster nested part adaptation ([344e758](https://github.com/henry753951/volleyball-monitoring-ai/commit/344e758ff9a1b457b7f43771561c92367655c7d5))
* **reid:** manage local and global identity assignments ([a6f99f6](https://github.com/henry753951/volleyball-monitoring-ai/commit/a6f99f6f1527501fb2660f33facdb1f33d8a8c34))
* **reid:** propagate global identities across tracks ([34f6c32](https://github.com/henry753951/volleyball-monitoring-ai/commit/34f6c32424dc28f17c504e60ea81dee58cc6657a))
* **web:** add player action analytics ([ec33db8](https://github.com/henry753951/volleyball-monitoring-ai/commit/ec33db867ee12483f0ff940de516cbf087c08ed6))
* **web:** redesign coach analysis surfaces ([#71](https://github.com/henry753951/volleyball-monitoring-ai/issues/71)) ([a4895ff](https://github.com/henry753951/volleyball-monitoring-ai/commit/a4895ffa87e9b883a37b73800bb8965f270f7c18))


### Bug Fixes

* harden live processing and annotation workflows ([8d6d468](https://github.com/henry753951/volleyball-monitoring-ai/commit/8d6d46827574202f4125e5a83db37162ec0750a3))
* harden live processing and annotation workflows ([13f6d1e](https://github.com/henry753951/volleyball-monitoring-ai/commit/13f6d1e26e6d568e95ac283824a35bf5ddcf2603))
* **web:** clarify coach navigation and match state ([8555287](https://github.com/henry753951/volleyball-monitoring-ai/commit/85552871a5dc9841cbd4484e0f521b43f4602bfc))
* **web:** refine coach navigation density ([7270ada](https://github.com/henry753951/volleyball-monitoring-ai/commit/7270adaa76368bba1ba8945c3b72cb8e138e41bd))


### Maintenance

* refresh checksum manifest ([0476df2](https://github.com/henry753951/volleyball-monitoring-ai/commit/0476df208b356a84de0c798a240e03e7a2c3963b))

## [0.4.0](https://github.com/henry753951/volleyball-monitoring-ai/compare/v0.3.1...v0.4.0) (2026-08-12)


### Features

* **annotation:** coalesce timeline and export analysis clips ([864234c](https://github.com/henry753951/volleyball-monitoring-ai/commit/864234ca505f13f7e4773c78420df9d74082090c))
* improve annotation responsiveness and storage operations ([0e00b76](https://github.com/henry753951/volleyball-monitoring-ai/commit/0e00b76f49449a56c22a418c71585d23e66b2e06))


### Bug Fixes

* **release:** sync manifest with v0.3.1 ([a5ca833](https://github.com/henry753951/volleyball-monitoring-ai/commit/a5ca8337331478a01353a99fe952ba5c41203af7))
* **release:** sync manifest with v0.3.1 ([0eb474d](https://github.com/henry753951/volleyball-monitoring-ai/commit/0eb474d0553252b4f7676c83d2f8aa37f967364e))
* **storage:** secure telemetry and clean durable spools ([a56ba93](https://github.com/henry753951/volleyball-monitoring-ai/commit/a56ba93093001f209f740473ddc59bba83eed370))


### Maintenance

* **checksums:** include spool cleanup test ([bf6f633](https://github.com/henry753951/volleyball-monitoring-ai/commit/bf6f633add04573fcc1c3bdb31b8a66281353c08))
