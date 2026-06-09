# 世界杯比分预测工作流

## 节点

### 信息检索师
- agent: 信息检索师
- dependsOn: []

### 信息分析师
- agent: 信息分析师
- dependsOn: [信息检索师]

### 决策官
- agent: 决策官
- dependsOn: [信息分析师]
