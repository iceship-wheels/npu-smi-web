#!/bin/sh
# 将键值格式的 `npu-smi info -t usages` 输出转换为 web 端可解析的管道表格。
# 适用于 Ascend910 等输出为 "Key : Value" 格式的 npu-smi 版本。
# 安装: cp scripts/npu-monitor.sh /usr/local/bin/npu-monitor.sh && chmod +x /usr/local/bin/npu-monitor.sh
# 依赖: npu-smi (CANN toolkit), awk, seq
echo "| NPU-ID | AICore(%) | HBM-Usage(MB) |"
for n in $(npu-smi info -l 2>/dev/null | awk '/NPU ID[[:space:]]*:/{print $NF}'); do
  npu-smi info -t usages -i "$n" 2>/dev/null | awk -v npu="$n" '
    /Aicore Usage Rate/ {ac=$NF}
    /HBM Usage Rate/ {hu=$NF}
    /HBM Capacity/ {hc=$NF}
    /Chip ID/ {id=npu*2+$NF; used=int(hc*hu/100); printf "| %d | %s | %d / %d |\n", id, ac, used, hc}
  '
done
