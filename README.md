# dsh-history-rag

给 DeepSeek Harness（DSH）的对话历史 RAG 插件。

**全部历史文字对话 → 原文切块 → Embedding → SQLite → 每个新用户输入前自动向量检索 → 注入命中原文。**

## 0.6.0：GitHub 自动更新检查

固定检查仓库 [viiiseven/dsh-history-memory](https://github.com/viiiseven/dsh-history-memory)。继续使用安装包方式；此功能只读取更新信息并提示，不下载、执行或安装远程代码，也不启用开发链接或热重载。

- 默认启动约 15 秒后自动检查，此后每 6 小时检查一次。结果和下次检查时间缓存在本地 SQLite，重启不会重复请求仍有效的检查；升级包或构建提交变化后会重新检查。
- 设置页顶部新增 **插件更新**，显示当前版本、检查结果及下次检查时间，可点击 **检查插件更新**。手动检查最短间隔 1 分钟，同一时间的多个请求合并执行；无需先打开设置页才会自动检查。
- 优先识别新的正式 GitHub Release；没有新 Release 时读取 `main` 的 `package.json`。远端版本高于当前安装版本才提示版本更新，远端较旧时不会提示降级。
- 安装包带有构建提交且无未提交修改时，同版本号也会比较已安装提交与远端 `main` 的先后关系：只有远端确实领先才提示 **仓库有新提交（版本号未变）**。未知提交、分叉或本地修改不会直接当成新版本。
- GitHub API 不可用或限流时，尝试读取该仓库的公开 `package.json`，并明确显示 **仅比较版本号，未检查同版本提交变化**。无法访问仓库时显示失败与重试状态，不误报“已是最新”。
- **查看更新** 打开该仓库的 Release、源码或提交比较页面，由你决定何时安装。检查请求只包含公开仓库地址及版本/提交信息，不携带对话、摘要、Embedding Key 或文件路径。

发布安装包前先提交源码，然后在仓库目录执行：

```powershell
npm pack --pack-destination ..\packages --offline
```

`prepack` 会把当前 Git 提交及是否包含未提交修改写入包内的 `build-info.json`，该文件不进入 Git。源码归档或省略构建步骤、没有提交标识的安装包仍能比较版本号。推荐每次正式更新提高 `package.json.version` 并推送到仓库；也可以发布对应版本的 Release。修改后未推送的本地源码不会被远程检查发现。

## 0.5.0：常驻记忆摘要

在 **设置 → 对话历史 RAG → 常驻记忆摘要** 查看或修改摘要正文，点击 **保存摘要** 即时保存到本地 SQLite。摘要为同一数据目录下跨会话共享的一份文本，适合背景、偏好、约定、项目进展和待办；`scope` 继续约束原文 RAG，摘要本身是全局共享的。显式排除的会话和工作目录不会成为新的摘要输入。

- **后台自动增量更新** 默认开启。复用 DSH 的默认聊天模型及其鉴权；未提供该默认服务时，使用最近参与会话的已路由聊天模型。摘要生成不使用 Embedding Key，也不调用任何工具。
- 原文扫描稳定后默认等待 30 秒再开始，自动更新间隔至少 60 秒；每批处理有限的新增原文。首次逐批处理已有历史，以后只处理尚未整理的新内容或修改后的片段。相同原文的 fork 副本只整理一次。
- 每批将“当前摘要 + 新增原文”交给模型，生成完整的新摘要。仅保存文本输出，忽略思考块；空输出、截断、超长、超时或失败均保留旧摘要，不将该批标为完成，稍后重试。
- **立即更新摘要** 在后台开始处理待整理的原文，无需等待自动更新间隔，也不会阻塞聊天。关闭自动更新后，仍可手动填写、点击立即更新，并继续将已保存摘要带入新会话。
- 新会话第一次真实用户输入时，将当前非空摘要作为独立 `user` 消息追加到上下文，正文以“记忆摘要：”开头。当前可见消息中已有摘要时不重复追加；压缩移出后在下一轮真实输入补回。已有会话中的摘要保持当时版本，编辑后的版本会在新会话或压缩补回时使用。
- 摘要写入带版本校验。手动保存会取消较早的生成任务；过期窗口无法覆盖新版本。后台刷新不会覆盖正在编辑的草稿，出现冲突时保留草稿，并提示复制、重新加载后合并保存。
- 摘要及处理进度保存在 `memory_summary` 和 `memory_seen` 表，重启后继续；它们不替代或清空原始 chunks 和向量。自动注入的摘要不会再次进入原文索引，也不会被拿去继续生成摘要。

摘要生成会消耗所选聊天模型的用量，该模型会接收当前摘要和每批新增原文。设置中显示使用的模型、已整理与待整理片段数、更新时间和重试状态。未配置聊天模型时仍可手动填写摘要，原文 RAG 功能照常运行。

可修改 `lib/memory-prompts.js` 中的 `MEMORY_INSTRUCTION`（后台整理要求）及 `MEMORY_INTRO`（注入前缀）。你在 0.4.1 修改的原文召回和主动回忆提示词保持原样。

## 0.4.0：基础地址与模型列表

接口地址现在兼容服务商给出的基础地址，不需要手动拼 `/embeddings`：

| 输入 | 实际 Embedding 请求 |
| --- | --- |
| `https://maas.qianwenaiapi.com/compatible-mode/v1` | 同地址追加 `/embeddings` |
| `https://example.com/v1/` | `https://example.com/v1/embeddings` |
| `http://localhost:11434` | `http://localhost:11434/v1/embeddings` |
| 已含 `/embeddings` 的完整地址 | 不重复追加 |
| 自定义完整路径，如 `/api/embed` | 保持原路径；仍需该服务接受 OpenAI Embedding 请求格式 |

基础地址与对应完整地址共用同一个向量身份，切换这两种填法不会重新生成已有向量。测试成功时会显示实际请求地址。

默认后台批量改为 10 条，兼容阿里云 `text-embedding-v4` 等每次最多 10 条的模型，避免单条测试成功但后台索引被拒绝。如果旧配置显式设置了更大的 `batchSize`，使用这类模型时也请改为 10。

设置页新增 **获取模型列表**：填好地址和 Key（如需要）后即可点击，无须先填写模型。列表使用服务的 `/models` 接口；对已识别的阿里云兼容地址，如果该接口明确不支持，会尝试同域的 `/api/v1/models`。支持 OpenAI 游标分页和阿里云目录分页；最多读取 20 页，超出时标明部分列表。

- 使用当前草稿中的 Key，留空则使用已保存的 Key；获取列表不保存草稿、不请求向量、不发送历史原文。
- 原样保留服务返回的模型 ID，并将名称或能力信息提示为向量模型的项优先分组。这里的“疑似向量模型”不是能力认证，不会自动替你选择或替换模型；选好后请测试连接。
- 普通别名仍保留在“其他模型”中，支持继续手动填写。服务未开放模型列表、自定义地址无法推导列表路径、权限不足或获取超时时，会保留输入并提示手动填写。
- 改地址、Key 或重新加载设置会清空旧列表，避免把另一服务的模型列表误当成当前服务的。
- Key 只发送给所填服务的同域接口，不跟随重定向；响应只返回模型 ID 和分类，不回传 Key。模型列表路由沿用 DSH Connection 的 owner 访问控制。

已用模拟服务验证基础地址补全、鉴权、分页、模型选择、失败后手填和真实 DSH Connection 路由。未使用你的真实 Key 验证某家服务的模型可用性；列表能获取也不代表其中所有模型都支持 Embedding，最终以连接测试为准。

## 0.3.0：上下文去重与主动回忆

自动召回和主动回忆默认都返回 **前 3 个片段**。去重依据是 DSH 当前仍向模型展示的消息，而不是永久的“读过”标记：

- 已注入的原文片段仍在当前上下文中时，后续检索会跳过它，再从剩余候选里选前 3 个。
- DSH 压缩或替换掉对应消息后，该片段重新具备召回资格；只在摘要中提到它，不会把原文永久标成已读。
- 识别自动注入和主动工具结果，也支持会话重放后的去重。同内容的 fork 副本共用原文哈希，避免换一个出处又重复注入。
- 片段内容被原会话修正后，会按新内容重新判断；不是只看一个可能复用的位置 ID。
- 0.2.0 已注入且完整保留的原文会尽力识别；旧版因预算截断的片段缺少完整引用信息，不会误认为已完整出现。新版本只记录实际投递的片段引用。

新增模型工具 **`history_recall`**，模型在自动召回不足时可以主动调用：

```javascript
history_recall({ query: "蓝鲸 部署端口", mode: "keyword" })
history_recall({ query: "我们上次怎么解决部署问题的？", mode: "embedding" })
```

- `keyword`：本地原文字面匹配，大小写不敏感，多个关键词用空格分隔并要求全部命中。支持短中文词和按字面搜索符号，不调用 Embedding、不依赖向量覆盖率。
- `embedding`：使用当前配置的 Embedding 做向量语义检索，仍按相似度阈值筛选；未配置时会明确提示模型改用关键词模式，不伪装成向量检索。省略 `mode` 时默认此模式。
- 两种模式都遵守已有工作区范围、显式排除列表、当前上下文去重及注入预算，返回带来源的原文。工具结果会由 DSH 正常进入上下文，不再额外补发一份自动注入；也不会被当作新原文再次入库。
- Native 工具模式可直接调用；Code Mode 中可使用 `await tools.history_recall(...)` 取得结构化结果。关键词排序分和向量余弦分的含义不同，不应跨模式比较数值。

新安装的默认 `topK` 为 3。如果旧的配置文件里显式写了 `"topK": 5`，请把它改为 3；显式配置仍具有优先级。

## 设置界面（0.2.0）

安装并启用后，打开 **设置 → 对话历史 RAG**：

1. 填写 Embedding 基础地址或完整请求地址，以及 API Key（本地免鉴权服务可留空）。点击 **获取模型列表** 选择模型，或直接填写模型 ID。
2. 可先点 **测试连接**，查看返回的向量维度和耗时。测试只发送固定测试文字，不提交历史对话、不保存草稿。
3. 点击 **保存并开始索引**。配置立即生效，不必重启 DSH。首次历史回填和向量化会在后台继续。
4. 下方实时显示历史扫描会话数、原文片段数、待向量化片段数，以及独立的扫描和向量化进度。**检查历史** 会立即核对新增或变更的会话，不会清空向量。

Key 输入框默认隐藏；已有 Key 不会从服务端返回界面。留空会保留原 Key，勾选 **清除已保存的 Key** 才会移除当前本地 Key 引用。通过界面保存的 Key 使用独立本地文件，不写入配置 JSON 或向量数据库。更换 Key 时只清理插件自己管理的旧 Key 文件，不删除用户原有的外部 Key 文件。

地址、模型或 Key 若由环境变量、插件行配置覆盖，对应字段会显示为受控状态，避免出现“保存了但不生效”。其他浏览器窗口改过配置时，会拒绝过期保存，保留当前草稿；点 **重新加载设置** 后再编辑。

修改地址、模型后，旧请求会被取消，新的向量按模型身份单独生成。向量化进度随之重新统计。界面依赖 DSH 自带的 React 和原生设置扩展点，没有新增运行时依赖；设置和状态请求走 DSH Connection 的鉴权通道，只有 owner 身份可以访问。

## 包含的功能

- 启动时通过 DSH 公共 `sessionQuery` 服务扫描全部可读取会话，不限制最近几天，也不排除归档会话。
- 读取完整原始日志，包含被上下文压缩遮蔽的用户原话和助手回答。
- 监听新增原文事件，并定时核对完整会话列表，补齐停机期间的记录。
- 原文逐字切块，保留会话 ID、事件 seq、片段编号、角色、时间和工作目录。
- 在后台批量请求 OpenAI 兼容 `/embeddings`；已向量化的相同文本直接复用，失败会退避重试。
- 每次新的真实用户输入进入 `agent/pre-step` 时，自动执行向量检索并把原文片段折入该步消息。
- 按当前会话的公开 surface 节点与当前可见消息排除已出现的原文，压缩移出后允许再召回；不索引插件注入和主动回忆工具返回的上下文。
- 查询有独立等待上限；接口失败或超时会跳过本轮召回，聊天继续，状态中记录错误阶段和错误码。
- 切换地址、模型、维度或指令前缀后使用独立向量身份，后台自动为原文重新向量化，不混用旧模型向量。
- SQLite 写入和全量余弦扫描在 worker 线程执行，无额外数据库服务、无原生依赖安装步骤。

## 环境与验证范围

- Node.js **>=24.2**，使用内置 `node:sqlite`。
- DSH 提供 `sessionQuery`、`agents` 服务和当前的 `agent/pre-step` waterfall。
- 已在本机安装的 **DSH 0.2.1-rc.3 / Cordis 4.0.5** SDK 上完成隔离接入测试：真实会话服务、插件生命周期、原生 waterfall、主动工具注册与执行、工具结果 schema、消息回放去重、压缩后的重新召回、Connection 设置路由和 owner 访问控制。测试使用合成对话，没有启动或修改用户日常 profile。
- 已在真实浏览器中检查设置页渲染、连接测试、保存、模型切换后进度更新、Key 不回显和浅色/深色显示；该预览使用真实 DSH Connection 和合成对话，外围设置容器为测试外壳。
- Embedding 的 HTTP 协议、鉴权、乱序批量响应和超时使用本机模拟服务测试。尚未选择真实 Embedding 模型，未完成真实语料上的语义质量评测，也未验收用户日常桌面 profile 中的实际对话。

## 安装

使用 DSH 插件管理器安装项目目录或 `dsh-history-rag-0.6.0.tgz`，启用后完全退出并重新打开 DSH。以桌面版 profile 为例：

```powershell
dsh plugin --profile desktop add "安装包或本项目的绝对路径"
```

然后在 **设置 → 对话历史 RAG** 填写服务信息。已有 0.1.0 / 0.2.0 / 0.3.0 数据会沿用，无须清库。设置界面和设置路由已分别验收；0.3.0 已通过 DSH 自带 CLI 安装到桌面 profile，插件管理器的桌面安装点击流程尚未实机验收。

## 配置文件方式（可选）

1. 在本项目目录执行下面命令，创建配置模板。已有文件会被保留。

   ```powershell
   node .\cli.js init
   ```

2. 打开输出的 `config.json`，填写两项：

   ```json
   {
     "embeddingEndpoint": "https://你的服务地址/v1/embeddings",
     "embeddingModel": "你的向量模型名称"
   }
   ```

   地址支持**基础地址或完整的 Embedding 请求 URL**，例如阿里云提供的 `https://maas.qianwenaiapi.com/compatible-mode/v1`。支持接受 OpenAI 格式请求的云端接口，以及提供兼容接口的本地服务。

   Ollama 可填写 `http://127.0.0.1:11434/v1/embeddings`，模型填写你实际安装的向量模型名称。

3. 需要 Key 的接口可二选一：

   - 在启动 DSH 的进程环境中设置 `HISTORY_RAG_API_KEY`。
   - 在配置目录创建 `embedding.key`，仅写入 Key；在 `config.json` 设置 `"apiKeyFile": "embedding.key"`。相对路径从数据目录解析。适合从桌面图标启动 DSH 的情况。

   环境变量优先于 Key 文件；Key 不会进入原文和向量数据库。Key 文件是本地明文文件，不要提交到源码仓库。

4. 安装本地项目或打包文件。以桌面版 profile 为例：

   ```powershell
   dsh plugin --profile desktop add "本项目的绝对路径"
   # 也可以将参数替换为 dsh-history-rag-0.6.0.tgz 的绝对路径
   ```

   完全退出并重新打开 DSH。若命令行中没有 `dsh`，可在 DSH 插件管理的添加入口使用本地安装来源；桌面 GUI 安装流程尚未实机验收。

5. 首次历史回填与向量化在后台完成，时间取决于历史规模和接口速度。用下面命令确认覆盖率，之后正常聊天即可。

   ```powershell
   node .\cli.js status
   ```

手动更改配置文件后重启插件或 DSH；界面保存的地址、模型和 Key 立即生效。完整模板见 `config.example.json`。环境变量 `HISTORY_RAG_ENDPOINT`、`HISTORY_RAG_MODEL` 可覆盖地址和模型。

## 数据放在哪里

默认目录：`<DSH_HOME>/history-rag/`。未设置 `DSH_HOME` 时，使用用户目录下的 `.dsh/history-rag/`。

```text
history-rag/
  config.json          本地配置
  embedding.key        可选的本地 Key 文件
  embedding-ui-*.key    设置界面保存的当前 Key 文件（内容不回显）
  history.sqlite       原文片段、来源、向量、进度、失败重试状态
  history.sqlite-wal   SQLite 正在运行时可能存在
  history.sqlite-shm
```

可用 `HISTORY_RAG_DATA_DIR` 或插件行的 `dataDir` 调整数据目录；`HISTORY_RAG_CONFIG` 或 `--config` 调整配置文件位置。

一个索引目录同一时间只允许一个运行中的 DSH 插件实例写入，避免重复向量化和互相覆盖。正常退出立即释放租约，异常终止后最多等待 60 秒。多个 DSH 实例请配置不同 `dataDir`。CLI 状态和搜索可同时读取。

插件不会修改 DSH 的原始会话文件。归档不会让原文退出索引。若某条原始消息被宿主改写或删除，下一次读取该会话时同步更新相应片段；不会基于“重要性”或“多久没用”清理内容。源会话整个消失时不会自动删除插件已保存的原文。

## 常用参数

| 参数 | 默认值 | 含义 |
|---|---:|---|
| `scope` | `all` | 跨全部会话检索；`workspace` 限制到当前工作目录 |
| `topK` | 3 | 自动召回和主动工具每次最多返回的原文片段数 |
| `minScore` | 0.35 | 归一化向量的余弦相似度下限，需按实际模型调节 |
| `maxContextChars` | 6000 | 单轮注入的字符预算，包含来源标记 |
| `recallTimeoutMs` | 3000 | 自动召回等待上限 |
| `chunkChars` / `chunkOverlap` | 800 / 120 | 每块 Unicode 字符数及重叠数 |
| `batchSize` | 10 | 后台 Embedding 批量条数；按服务商限制调整 |
| `scanIntervalMs` | 60000 | 全部会话核对间隔 |
| `dimensions` | 0 | 0 表示由响应推断；非零时发送维度参数并校验 |
| `queryPrefix` / `documentPrefix` | 空 | 给需要不同检索指令的模型配置前缀 |
| `queryMaxChars` | 4000 | 查询输入过长时，只向 Embedding 发送开头这些字符 |
| `includeToolResults` | false | 额外索引工具返回里的文字块 |
| `humanSourceKinds` | `user`, `prompt` | 真实用户消息的来源标识；其他聊天桥接可按其真实来源增加 |
| `memoryMaxChars` / `memoryMaxTokens` | 6000 / 4096 | 摘要正文字符上限 / 生成 token 上限 |
| `memoryInputChars` | 16000 | 每批新增原文的字符预算；单个超大原文片段会完整处理 |
| `memoryDebounceMs` / `memoryIntervalMs` | 30000 / 60000 | 对话变更后的等待时间 / 自动更新最短间隔 |
| `memoryTimeoutMs` | 120000 | 单批摘要生成等待上限 |
| `updateCheckEnabled` | true | 是否后台自动检查 GitHub 更新；关闭后仍可手动检查 |
| `updateCheckIntervalMs` / `updateCheckTimeoutMs` | 21600000 / 10000 | 自动检查间隔（6 小时）/ 单次检查等待上限 |
| `excludeSessionIds` / `excludeWorkspaces` | 空数组 | 显式排除的会话和工作目录，工作目录按完整路径精确匹配 |

默认“全部历史”指宿主可读取的全部用户与助手文字对话。图片、音频、文件正文不做 OCR 或转录，模型思考块、系统提示和工具调用参数不属于默认语料。工具文字结果可显式开启。尚不支持导入其他软件的聊天导出文件。

## 查看、调试与重建

```powershell
node .\cli.js status
node .\cli.js search "我们以前怎么处理那个部署问题"
node .\cli.js reindex              # 请求重新核对全部源会话，复用现有向量
node .\cli.js reindex --vectors    # 请求清空当前模型的向量缓存并重新计算
```

重建请求由运行中的插件在下一轮扫描处理，CLI 不会读取或改写源会话。`status` 返回总片段数、已向量化片段数、待处理量、覆盖率及最近错误状态。`state.lastScan.discoveredSessions` 是发现的会话数，`state.sessionFailures` 列出读取失败的会话；向量覆盖率仅以已入库片段为分母，不能单看 100% 就认定所有源会话都已读取成功。只查询已完成向量化的原文，首次覆盖率未满时可能漏召回。

使用远程 Embedding 时，建库会把原文片段发送到你配置的接口；查询时发送当前问题。调用聊天模型时会携带常驻摘要和命中的历史原文。后台摘要更新另外产生 DSH 聊天模型的用量；原文 RAG 仍产生 Embedding 与注入上下文的费用。

## 实现和测试

| 路径 | 职责 |
|---|---|
| `index.js` | 注册原生事件、生命周期与自动注入 |
| `lib/runtime.js` | 全部会话回填、实时增量、后台向量化与重试 |
| `lib/text.js` | 从日志中选取原始文字，逐字切块 |
| `lib/embedding.js` | OpenAI 兼容 Embedding 请求与模型身份 |
| `lib/endpoints.js` | 基础地址补全、完整请求地址与模型列表路径 |
| `lib/models.js` | 服务模型列表、同域目录兼容与分页 |
| `lib/updates.js`, `scripts/build-info.mjs` | GitHub 更新检查、构建提交标识、缓存与失败重试 |
| `lib/store.js` | SQLite、向量缓存、余弦排序和来源过滤 |
| `lib/database.js`, `lib/db-worker.js` | 独立数据库线程及取消信号 |
| `lib/recall.js` | 用户输入提取、来源归因、预算控制与自动注入 |
| `lib/context.js` | 当前可见消息中的片段引用、重放与压缩后的去重判定 |
| `lib/tool.js` | 模型主动回忆工具、关键词/向量模式和结构化原文结果 |
| `lib/memory.js` | 常驻摘要的增量任务、手动编辑、版本冲突与上下文注入 |
| `lib/host-summary.js`, `lib/memory-prompts.js` | DSH 默认聊天模型接入、摘要提示词与纯文本输出校验 |
| `lib/settings.js` | 设置持久化、Key 管理、连接测试和原生鉴权路由 |
| `client.js` | 原生设置页、草稿编辑和实时索引进度 |

```powershell
npm test
npm run check
# 可选：接入已安装 DSH 的隔离 SDK 副本，运行真实服务测试
$env:HISTORY_RAG_TEST_SDK = 'SDK副本的node_modules绝对路径'
node --test test/host.test.js
# 可选：使用 React / React DOM 18 和 jsdom 26 的测试目录
$env:HISTORY_RAG_TEST_UI_MODULES = '界面测试依赖的node_modules绝对路径'
node --test test/client.test.js
```

测试使用临时数据库与合成对话。本机 HTTP 测试需要允许回环网络连接。

当前向量检索是 SQLite BLOB 上的**精确全量余弦扫描**，没有 ANN 索引；数据库工作在独立线程。规模很大时检索成本仍随片段数增长，受召回时间预算约束。后台每轮核对需要读取源会话，首次读超长会话及切块也有开销。第一版尚未做大规模性能基准。

接入依据：[DSH 插件扩展点](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/extension-cookbook.md)、[sessionQuery](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session-query/session-query/src/index.ts)、[原生 pre-step 示例](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/context/time-context/src/index.ts)。
