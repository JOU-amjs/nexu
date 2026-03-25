# 自动化 Issue 分拣系统

## 设计目标与核心原则

+ **单一事实来源 (Single Source of Truth)：** 所有状态、评论和决议均以 GitHub 为准，避免信息在 GitHub 和飞书之间割裂。
+ **Label 即状态机 (Labels as State Machine)：** 除 `Roadmap` 命中后“直接回复并结束”这一路径外，其余自动化动作（发送通知、自动回复、关闭 Issue）都由 GitHub Issue 的 Label 变更来触发或标识。
+ **命令优先而非手工打标：** PM 不直接手工添加 `triage:*` 标签，而是在 Issue 下通过评论命令（如 `/triage accepted`）触发自动打标与后续流程，确保操作一致、可审计、可回放。
+ **尽早降噪与拦截：** 通过自动查重和信息完整度检查，将无效或低质量的 Issue 挡在 PM 人工分拣之前。
+ **渐进式增强：** 飞书仅作为辅助通知通道，不承载复杂的审批逻辑。

## 核心状态与标签定义 (State & Labels)

系统将依赖以下标签组合来驱动整个分拣流程：

| **标签 (Label)**     | **含义与作用**                    | **添加方式** | **后续触发动作**                                   |
| -------------------- | --------------------------------- | ------------ | -------------------------------------------------- |
| `bug`                | 该 Issue 被识别为 Bug            | 🤖 自动       | 仅作为分类标签；后续飞书通知会据此发送到不同群     |
| `possible-duplicate` | 疑似重复 Issue                  | 🤖 自动       | 进入人工复核队列；同时补打 `needs-triage`          |
| `needs-information`  | 核心信息缺失（如缺复现步骤）     | 🤖 自动       | 提示用户补充并暂停流转，等待补充后再继续处理        |
| `needs-triage`       | 等待人工分拣                    | 🤖 自动       | 所有需要人工处理的 Issue 都应带此标签；飞书通知再根据是否带 `bug` 标签分群 |
| `triage:accepted`    | PM 确认接收该需求/Bug             | 👨‍💻 评论命令   | 🤖 自动移除 `needs-triage` 并回复用户               |
| `triage:declined`    | PM 拒绝处理（不采纳或不修复）     | 👨‍💻 评论命令   | 🤖 自动移除 `needs-triage`，回复婉拒文案并 Close Issue |
| `triage:duplicated`  | PM 确认该 Issue 为重复            | 👨‍💻 评论命令   | 🤖 自动移除 `needs-triage`，回复重复说明并 Close Issue |

## 整体工作流

*图例说明：*

+ 🤖 **自动检测/判断** (GitHub Actions + LLM)
+ 🏷️ **自动打标** (Automated Labeling)
+ 💬 **自动回复** (Automated Commenting)
+ 👨‍💻 **人工操作** (Manual Action)

### Phase 1: 自动预处理

```mermaid
graph TD
    classDef autoProcess fill:#e1f5fe,stroke:#01579b,stroke-width:2px;
    classDef labelAction fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px;
    classDef replyAction fill:#f3e5f5,stroke:#4a148c,stroke-width:2px;
    classDef endState fill:#f5f5f5,stroke:#9e9e9e,stroke-width:2px;

    Start([🆕 新 Issue 提交]) --> BasicProcess

    direction LR

BasicProcess[🤖 基础处理: 欢迎词 & 自动翻译 & 意图分类 & Bug 打标] --> RoadmapCheck

    RoadmapCheck{🤖 是否已在 Project Roadmap 中?}
    RoadmapCheck -- Yes --> ReplyRoadmap[💬 回复: 告知预计上线时间] --> EndPre2([结束, 无需分拣])
    RoadmapCheck -- No --> DupeCheck

    DupeCheck{🤖 是否疑似重复?}
    DupeCheck -- Yes --> LabelDupe[🏷️ 打标: possible-duplicate] --> ReplyDupe[💬 回复: 推荐相似 Issue] --> LabelTriageDupe[🏷️ 打标: needs-triage]
    DupeCheck -- No --> InfoCheck

    InfoCheck{🤖 信息是否完整?}
    InfoCheck -- 缺失 --> LabelInfo[🏷️ 打标: needs-information] --> ReplyInfo[💬 回复: 提示补充信息] --> EndPre3([暂停流转, 等待用户补充])
    InfoCheck -- 完整 --> TriageReady[🏷️ 打标: needs-triage]

    LabelTriageDupe --> NotifyByBug1{🏷️ 是否带 bug 标签?}
    TriageReady --> NotifyByBug2{🏷️ 是否带 bug 标签?}
    NotifyByBug1 -- Yes --> NotifyBug1[🔔 飞书通知 Bug 群]
    NotifyByBug1 -- No --> NotifyNonBug1[🔔 飞书通知需求群]
    NotifyByBug2 -- Yes --> NotifyBug2[🔔 飞书通知 Bug 群]
    NotifyByBug2 -- No --> NotifyNonBug2[🔔 飞书通知需求群]

    class BasicProcess,RoadmapCheck,DupeCheck,InfoCheck,NotifyByBug1,NotifyByBug2 autoProcess;
    class LabelDupe,LabelTriageDupe,LabelInfo,TriageReady labelAction;
    class ReplyDupe,ReplyRoadmap,ReplyInfo replyAction;
    class Start,EndPre2,EndPre3,NotifyBug1,NotifyBug2,NotifyNonBug1,NotifyNonBug2 endState;
```

### Phase 2: 人工分拣

```mermaid
graph TD
    classDef labelAction fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px;
    classDef replyAction fill:#f3e5f5,stroke:#4a148c,stroke-width:2px;
    classDef manualAction fill:#fff3e0,stroke:#e65100,stroke-width:2px;
    classDef endState fill:#f5f5f5,stroke:#9e9e9e,stroke-width:2px;

    WaitPM([有 needs-triage 标签的 issues]) --> PMAction{👨‍💻 评论命令<br/>/triage accepted<br/>/triage declined<br/>/triage duplicated}

    PMAction -- "/triage accepted" --> LabelAccept[🏷️ 打标: triage:accepted] --> ActionAccept1[🏷️ 移除 needs-triage] --> ReplyAccept[💬 回复: issue 已接收, 将排期开发] --> Done1([进入研发待办])

    PMAction -- "/triage declined" --> LabelDecline[🏷️ 打标: triage:declined] --> ActionDecline1[🏷️ 移除 needs-triage] --> ReplyDecline[💬 回复: 婉拒并说明原因] --> ActionClose[🛑 关闭 Issue] --> Done2([流程完结])

    PMAction -- "/triage duplicated" --> LabelDuplicated[🏷️ 打标: triage:duplicated] --> ActionDup1[🏷️ 移除 possible-duplicate] --> ActionDup2[🏷️ 移除 needs-triage] --> ReplyDupConfirmed[💬 回复: 确认为重复, 引导至主 Issue] --> ActionCloseDup[🛑 关闭 Issue] --> Done3([流程完结])

    class LabelAccept,LabelDecline,LabelDuplicated,ActionAccept1,ActionDecline1,ActionDup1,ActionDup2 labelAction;
    class ReplyAccept,ReplyDecline,ReplyDupConfirmed replyAction;
    class PMAction manualAction;
    class WaitPM,Done1,Done2,Done3 endState;
```

## Issue 状态流转

下面仅从 Issue 状态视角描述流转；每个状态都标注当前应有的 labels。

```mermaid
flowchart TB
    classDef state fill:#f8fafc,stroke:#334155,stroke-width:1.2px,color:#0f172a;
    classDef terminal fill:#ecfeff,stroke:#0e7490,stroke-width:1.2px,color:#083344;

    S0["新建/预处理中<br/>labels: 无"]:::state --> D0{"自动预处理分流"}

    D0 -- 命中 Roadmap --> S1["路线图已覆盖（结束）<br/>labels: 无"]:::terminal
    D0 -- 信息缺失 --> S2["待补充信息<br/>labels: needs-information"]:::state
    D0 -- 通过检查 --> S3["待人工分拣<br/>labels: needs-triage"]:::state
    D0 -- 疑似重复 --> S4["疑似重复待复核<br/>labels: possible-duplicate, needs-triage"]:::state

    S2 -- 用户补充后复检通过 --> S3

    S3 -- /triage accepted --> S5["已接收<br/>labels: triage:accepted"]:::terminal
    S3 -- /triage declined --> S6["已拒绝并关闭<br/>labels: triage:declined"]:::terminal

    S4 -- /triage accepted --> S5
    S4 -- /triage declined --> S6
    S4 -- /triage duplicated --> S7["已判重并关闭<br/>labels: triage:duplicated"]:::terminal
```
