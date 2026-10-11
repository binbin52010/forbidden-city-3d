# 数据来源与建模精度

本项目是可交互的北京故宫示意模型，不是测绘成果或文物修复图纸。建筑与水体的平面位置主要来自 OpenStreetMap（OSM）；屋顶、台基和大多数高度由程序依据建筑类型近似。故宫博物院资料仅用于核对建筑事实，没有复制其照片、地图、全景图或三维资产。

## 可复现的数据

- 宫城范围：[OSM relation 9511883](https://www.openstreetmap.org/relation/9511883)，抓取时为版本 17。
- 原始资料：[osm-source.json](../public/data/osm-source.json) 保存 OSM API 返回的 WGS84 节点、路径、关系及标签；[palace.json](../public/data/palace.json) 是浏览器使用的派生数据库。两者均按 [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) 分享，须署名 © OpenStreetMap contributors。许可提示见 [LICENSE-ODbL.txt](../public/data/LICENSE-ODbL.txt)。
- 更新脚本：[fetch-data.py](../tools/fetch-data.py)。在项目根目录运行 `python -m pip install -r tools/requirements.txt`，再运行 `python tools/fetch-data.py`；需要网络连接访问 OSM API。本次生成环境为 Python 3.9.13 与 Shapely 2.0.7。脚本覆盖两个 JSON 文件；每次运行获取当前 OSM 数据，因此结果可能随 OSM 编辑而变化。生成后执行 `npm run validate-model` 与 `npm run build`。
- 本次快照时间以 JSON 的 `metadata.fetchedAt` 为准。数据使用经纬度局部投影，X 向东、Z 向南，单位为米。建筑过滤范围严格使用宫城 relation；API 获取窗口向外延伸约 100 米，以纳入完整护城河。

`palace.json` 含 1,235 条建筑、城墙、宫门、塔楼、亭与台基记录、712 条步行路径、9 个宫城内闭合水面、25 条水道线，以及 10 个含护城河的水域多边形。`waterAreas` 保留外环和可能存在的内环；开放的水道线单独放在 `waterLines`，不会被闭合成水面。护城河轮廓源于 [OSM way 4845030](https://www.openstreetmap.org/way/4845030)。

“御花园”分区使用快照中标有 `leisure=garden; name=御花园` 的 [OSM way 30802178](https://www.openstreetmap.org/way/30802178) 闭合边界，以建筑中心点落在边界内判断。该分区有 31 条建筑记录。之前的宽矩形会将北排的钟粹宫、储秀宫等误划入御花园；这次已按花园轮廓重分区。分区用于场景导航，不等于各院落的法定或测绘边界。

## 主要建筑的依据

下表的“模型高”从场景地面量起，含模型台基和屋顶。没有可靠总高的建筑以视觉近似值表示，不应当作实测值。`roofHeight` 只是造型参数，包含在总高内。

| 建筑 | 模型高 | 屋顶与说明 | 资料 |
| --- | ---: | --- | --- |
| 太和殿 | 35.05 m | 重檐庑殿顶；官网记载总高 | [故宫博物院](https://www.dpm.org.cn/show/225724.html) |
| 中和殿 | 19 m | 单檐四角攒尖顶；高度来自北京市旅游资料，OSM 缺少殿身轮廓，约 24 m 方形基底按相邻殿宇和官网面积近似 | [故宫博物院](https://www.dpm.org.cn/explore/building/236464.html)、[北京市旅游资料](https://s.visitbeijing.com.cn/attraction/120829) |
| 保和殿 | 29.50 m | 重檐歇山顶；官网记载高度 | [故宫博物院](https://www.dpm.org.cn/explore/building/236434.html) |
| 乾清宫 | 24 m，近似 | 重檐庑殿顶；官网写自台面至正脊高“20余米”，此处取代表性模型值 | [故宫博物院](https://www.dpm.org.cn/show/225721.html) |
| 交泰殿 | 20.6 m，近似 | 单檐四角攒尖顶；官网记载形制，模型高度为展示估计 | [故宫博物院](https://www.dpm.org.cn/explore/building/236467.html) |
| 坤宁宫 | 21 m，近似 | 重檐庑殿顶；官网记载形制，模型高度为展示估计 | [故宫博物院](https://www.dpm.org.cn/explore/building/236487.html) |
| 午门 | 37.95 m | 主楼重檐庑殿顶；整体高度来自北京市旅游资料 | [故宫博物院](https://www.dpm.org.cn/explore/building/236454.html)、[北京市旅游资料](https://s.visitbeijing.com.cn/attraction/120916) |
| 太和门 | 23.8 m，近似 | 重檐歇山顶；官网记载形制，模型高度为展示估计 | [故宫博物院](https://www.dpm.org.cn/explore/building/236439.html) |
| 乾清门 | 16 m | 单檐歇山顶；官网记载约 16 m | [故宫博物院](https://www.dpm.org.cn/explore/building/236473.html) |
| 钦安殿 | 程序估计 | 真实屋顶为重檐盝顶，模型用 `luding` 截顶形制近似 | [故宫博物院](https://www.dpm.org.cn/explore/building/236494.html) |

## 东西六宫的名称与轮廓

下表链接指向快照中的单体建筑轮廓，不代表整座宫院的精确范围。故宫博物院资料用于核对现代通行名称和历史别名。

| 东六宫 | 对应 OSM 建筑 | 西六宫 | 对应 OSM 建筑 |
| --- | --- | --- | --- |
| 景仁宫 | [way 40631331](https://www.openstreetmap.org/way/40631331) | 永寿宫 | [way 40631817](https://www.openstreetmap.org/way/40631817) |
| 承乾宫 | [way 40631340](https://www.openstreetmap.org/way/40631340) | 翊坤宫 | [way 40631806](https://www.openstreetmap.org/way/40631806) |
| 钟粹宫 | [way 40631343](https://www.openstreetmap.org/way/40631343) | 储秀宫 | [way 40631826](https://www.openstreetmap.org/way/40631826) |
| 延禧宫 | [way 685316170](https://www.openstreetmap.org/way/685316170) | 长春宫 | [way 40631798](https://www.openstreetmap.org/way/40631798) |
| 永和宫 | [way 40631116](https://www.openstreetmap.org/way/40631116) | 咸福宫 | [way 40631832](https://www.openstreetmap.org/way/40631832) |
| 景阳宫 | [way 40631121](https://www.openstreetmap.org/way/40631121) | 启祥宫（今太极殿） | [太极殿 way 40631788](https://www.openstreetmap.org/way/40631788) |

OSM 的 way 40631340 和 [北门 way 42623372](https://www.openstreetmap.org/way/42623372) 原始标签分别写作“承干宫”“承干门”。派生数据库依据[故宫博物院承乾宫介绍](https://www.dpm.org.cn/explore/building/236438.html)显示为“承乾宫”“承乾门”，保留原始快照和 OSM way 链接。OSM 将启祥宫主殿标为“太极殿”；[故宫博物院说明](https://www.dpm.org.cn/explore/building/236475.html)启祥宫是其旧称，模型仍以今名“太极殿”标注该单体建筑。延禧宫轮廓在 OSM 标为 `building=ruins`，场景体量仅为示意。

四隅塔基在 OSM 中标作“东北/西北/东南/西南城墙”，模型按其约 28 米的方形位置和[故宫博物院角楼介绍](https://www.dpm.org.cn/explore/building/236522.html)作为角楼展示。复杂的三重檐屋顶和 24 米展示高度均为近似，并非 OSM 实测。OSM 中被标为普通建筑的五处石台/月台按原始 way ID 改为 `platform`，避免生成瓦屋顶；外朝三台的高度取官网所述 [8.13 米](https://www.dpm.org.cn/explore/building/236465.html)。

## 使用与再分发

OSM 和基于它制作的数据库应保留署名与 ODbL 许可。故宫博物院网页仅提供事实核对；其网站内容另有[版权说明](https://www.dpm.org.cn/bottom/privacy/254.html)，本项目不包含来自该站的媒体资产。有 OSM 轮廓的建筑在 `source` 字段提供对应 way 的直接链接；主要建筑另附形制或高度依据。中和殿没有对应的 OSM way，其 `source` 引用相邻两殿和公开建筑资料。
