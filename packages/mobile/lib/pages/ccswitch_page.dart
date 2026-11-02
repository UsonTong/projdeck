import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/ccswitch.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// CC Switch（AI 编程工具的供应商管理器）：用量统计，各应用的供应商（点一下切换，由电脑上的 CC Switch 完成），
/// MCP、Prompts、Skills（经调试端口操作电脑上的 CC Switch）。栏目可以左右滑动切换。
class CcSwitchPage extends StatefulWidget {
  const CcSwitchPage({super.key});

  static void open(BuildContext context) => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const CcSwitchPage()));

  @override
  State<CcSwitchPage> createState() => _CcSwitchPageState();
}

class _CcSwitchPageState extends State<CcSwitchPage> {
  CcStatus? _status;
  String? _error;
  double? _todayCost;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final s = await AppScope.read(context).api.ccStatus();
      if (mounted) setState(() => _status = s);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final s = _status;
    if (s == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('CC Switch')),
        body: Center(
          child: _error != null ? Text(_error!, style: TextStyle(color: p.mutedFg)) : const CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }
    final tabs = <(String, Widget)>[
      ('用量', _UsageTab(onTodayCost: (c) => _todayCost == c ? null : setState(() => _todayCost = c))),
      for (final a in s.apps) (a.label, _ProvidersTab(app: a, onStatus: (st) => setState(() => _status = st))),
      ('MCP', const _NeedsBridge(child: _McpTab())),
      ('Prompts', _NeedsBridge(child: _PromptsTab(apps: s.apps))),
      ('Skills', const _NeedsBridge(child: _SkillsTab())),
    ];
    return DefaultTabController(
      length: tabs.length,
      child: Scaffold(
        appBar: AppBar(
          titleSpacing: 0,
          title: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('CC Switch', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
              Text(
                [s.running ? '电脑上正在运行' : '电脑上没有运行（切换时会在后台启动）', if (_todayCost != null) '今天 ${usd(_todayCost!)}'].join(' · '),
                style: TextStyle(fontSize: 12, color: p.mutedFg),
              ),
            ],
          ),
          bottom: TabBar(
            isScrollable: true,
            tabAlignment: TabAlignment.start,
            dividerColor: p.border,
            indicatorColor: p.fg,
            labelColor: p.fg,
            unselectedLabelColor: p.mutedFg,
            labelStyle: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
            unselectedLabelStyle: const TextStyle(fontSize: 14),
            tabs: [for (final t in tabs) Tab(text: t.$1, height: 40)],
          ),
        ),
        body: !s.installed
            ? Center(
                child: Text('这台电脑上没有检测到 CC Switch', style: TextStyle(color: p.mutedFg)),
              )
            : TabBarView(children: [for (final t in tabs) t.$2]),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// 数字格式
// ---------------------------------------------------------------------------

String usd(double n) {
  final s = n.toStringAsFixed(2);
  final parts = s.split('.');
  final whole = parts[0].replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');
  return '\$$whole.${parts[1]}';
}

String thousands(int n) => n.toString().replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');

/// 4.33B、935M、18.6M：三位有效数字。
String compact(num n) {
  for (final (v, unit) in [(1e9, 'B'), (1e6, 'M'), (1e3, 'K')]) {
    if (n >= v) {
      final x = n / v;
      final s = x.toStringAsFixed(
        x >= 100
            ? 0
            : x >= 10
            ? 1
            : 2,
      );
      return '${s.contains('.') ? s.replaceFirst(RegExp(r'\.?0+$'), '') : s}$unit';
    }
  }
  return n.round().toString();
}

// ---------------------------------------------------------------------------
// 用量
// ---------------------------------------------------------------------------

enum _Metric { cost, requests, tokens }

enum _Table { models, providers, logs }

class _UsageTab extends StatefulWidget {
  final ValueChanged<double> onTodayCost;
  const _UsageTab({required this.onTodayCost});

  @override
  State<_UsageTab> createState() => _UsageTabState();
}

class _UsageTabState extends State<_UsageTab> with AutomaticKeepAliveClientMixin {
  String _range = '7d';
  String? _app;
  _Metric _metric = _Metric.tokens;
  _Table _table = _Table.models;
  CcUsage? _data;
  bool _loading = false;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    final d = await run(context, () => AppScope.read(context).api.ccUsage(_range, _app));
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (d != null) _data = d;
    });
    if (d != null) widget.onTodayCost(d.todayCost);
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final p = Palette.of(context);
    final d = _data;
    if (d == null) return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    final cards = [
      (_Metric.cost, '花费', usd(d.cost)),
      (_Metric.requests, '请求数', thousands(d.requests)),
      (_Metric.tokens, 'Tokens', compact(d.tokens)),
      (null, '缓存命中率', '${(d.cacheHitRate * 100).toStringAsFixed(1)}%'),
    ];
    final rows = _table == _Table.models ? d.models : d.providers;
    return RefreshIndicator(
      onRefresh: _load,
      child: AnimatedOpacity(
        opacity: _loading ? 0.6 : 1,
        duration: const Duration(milliseconds: 150),
        child: ListView(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 32),
          children: [
            // 筛选：时间范围、应用
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  SegmentedSwitch(
                    value: _range,
                    options: const {'today': '今天', '7d': '7 天', '30d': '30 天', 'all': '全部'},
                    onChanged: (v) {
                      setState(() => _range = v);
                      _load();
                    },
                  ),
                  const SizedBox(width: 8),
                  SegmentedSwitch<String>(
                    value: _app ?? '',
                    options: {'': '全部', for (final a in d.apps) a.app: a.label},
                    onChanged: (v) {
                      setState(() => _app = v.isEmpty ? null : v);
                      _load();
                    },
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            // 指标卡：点花费 / 请求数 / Tokens 切换下面图表的指标
            GridView.count(
              crossAxisCount: 2,
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              mainAxisSpacing: 8,
              crossAxisSpacing: 8,
              childAspectRatio: 2.3,
              children: [
                for (final (m, label, value) in cards)
                  _StatCard(label: label, value: value, selected: m == _metric, onTap: m == null ? null : () => setState(() => _metric = m)),
              ],
            ),
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.fromLTRB(12, 12, 12, 8),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: p.border),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${const {_Metric.cost: '花费', _Metric.requests: '请求数', _Metric.tokens: 'Tokens'}[_metric]} · ${_range == 'today' ? '每小时' : '每天'}',
                    style: TextStyle(fontSize: 12, color: p.mutedFg),
                  ),
                  const SizedBox(height: 10),
                  _BarChart(key: ValueKey('$_range|$_app|$_metric'), series: d.series, metric: _metric),
                ],
              ),
            ),
            const SizedBox(height: 16),
            SegmentedSwitch(
              value: _table,
              options: {_Table.models: '模型 ${d.models.length}', _Table.providers: '供应商 ${d.providers.length}', _Table.logs: '请求记录'},
              onChanged: (v) => setState(() => _table = v),
            ),
            const SizedBox(height: 8),
            AnimatedSwitcher(
              duration: const Duration(milliseconds: 200),
              child: _table == _Table.logs
                  ? Column(
                      key: const ValueKey('logs'),
                      children: [for (final l in d.logs) _LogTile(log: l)],
                    )
                  : Column(
                      key: ValueKey(_table),
                      children: [
                        if (rows.isEmpty)
                          Padding(
                            padding: const EdgeInsets.all(24),
                            child: Text('这段时间没有记录', style: TextStyle(color: p.mutedFg)),
                          ),
                        for (final r in rows) _UsageRowTile(row: r),
                      ],
                    ),
            ),
            const SizedBox(height: 12),
            Text('数据来自 CC Switch（只读），与它的用量页同口径。「≈」表示由会话日志估算。', style: TextStyle(fontSize: 11, color: p.mutedFg)),
          ],
        ),
      ),
    );
  }
}

class _StatCard extends StatelessWidget {
  final String label;
  final String value;
  final bool selected;
  final VoidCallback? onTap;
  const _StatCard({required this.label, required this.value, required this.selected, this.onTap});

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    return Material(
      color: selected ? p.accent : p.card,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap == null
            ? null
            : () {
                HapticFeedback.selectionClick();
                onTap!();
              },
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 180),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: selected ? p.ring : p.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text(label, style: TextStyle(fontSize: 12, color: p.mutedFg)),
              const SizedBox(height: 2),
              FittedBox(
                fit: BoxFit.scaleDown,
                alignment: Alignment.centerLeft,
                child: Text(
                  value,
                  style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700, fontFeatures: [FontFeature.tabularFigures()]),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 每天（或每小时）一根柱子：单一系列，载入时从底部长出来；点一根柱子显示这一天的全部指标。
class _BarChart extends StatefulWidget {
  final List<CcBucket> series;
  final _Metric metric;
  const _BarChart({super.key, required this.series, required this.metric});

  @override
  State<_BarChart> createState() => _BarChartState();
}

class _BarChartState extends State<_BarChart> with SingleTickerProviderStateMixin {
  late final AnimationController _grow = AnimationController(vsync: this, duration: const Duration(milliseconds: 500))..forward();
  int? _selected;

  @override
  void dispose() {
    _grow.dispose();
    super.dispose();
  }

  double _value(CcBucket b) => switch (widget.metric) {
    _Metric.cost => b.cost,
    _Metric.requests => b.requests.toDouble(),
    _Metric.tokens => b.tokens.toDouble(),
  };

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final series = widget.series;
    final max = series.fold<double>(0, (m, b) => _value(b) > m ? _value(b) : m);
    // 纵轴刻度取整：1、2、5 × 10^n
    var step = 1.0;
    if (max > 0) {
      final raw = max / 3;
      var mag = 1.0;
      while (mag * 10 <= raw) {
        mag *= 10;
      }
      while (mag > raw) {
        mag /= 10;
      }
      step = [1, 2, 5, 10].map((m) => m * mag).firstWhere((v) => v >= raw, orElse: () => 10 * mag);
    }
    final top = max <= 0 ? step : (max / step).ceil() * step;
    String fmt(double v) => widget.metric == _Metric.cost ? '\$${compact(v)}' : compact(v);
    final bar = p.dark ? const Color(0xff2b93cf) : const Color(0xff1d8ac7);
    const height = 150.0;
    final sel = _selected != null && _selected! < series.length ? series[_selected!] : null;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SizedBox(
          height: height,
          child: LayoutBuilder(
            builder: (context, c) {
              const axis = 40.0;
              final w = (c.maxWidth - axis) / series.length;
              return GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTapDown: (d) {
                  final i = ((d.localPosition.dx - axis) / w).floor();
                  setState(() => _selected = i >= 0 && i < series.length && i != _selected ? i : null);
                },
                child: AnimatedBuilder(
                  animation: _grow,
                  builder: (_, _) => CustomPaint(
                    size: Size(c.maxWidth, height),
                    painter: _BarPainter(
                      values: [for (final b in series) _value(b)],
                      top: top,
                      step: step,
                      axis: axis,
                      color: bar,
                      grid: p.border,
                      label: p.mutedFg,
                      highlight: p.accent,
                      selected: _selected,
                      progress: Curves.easeOutCubic.transform(_grow.value),
                      fmt: fmt,
                    ),
                  ),
                ),
              );
            },
          ),
        ),
        const SizedBox(height: 4),
        Padding(
          padding: const EdgeInsets.only(left: 40),
          child: Row(
            children: [
              for (var i = 0; i < series.length; i++)
                Expanded(
                  child: Text(
                    series.length <= 8 || i % (series.length / 6).ceil() == 0 || i == series.length - 1 ? series[i].label : '',
                    textAlign: TextAlign.center,
                    maxLines: 1,
                    overflow: TextOverflow.clip,
                    style: TextStyle(fontSize: 10, color: p.mutedFg),
                  ),
                ),
            ],
          ),
        ),
        // 选中的那一天
        AnimatedSize(
          duration: const Duration(milliseconds: 180),
          child: sel == null
              ? const SizedBox(width: double.infinity)
              : Container(
                  margin: const EdgeInsets.only(top: 10),
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  decoration: BoxDecoration(
                    color: p.popover,
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: p.border),
                  ),
                  child: Row(
                    children: [
                      Text(sel.label, style: const TextStyle(fontWeight: FontWeight.w600)),
                      const Spacer(),
                      Text(
                        '${usd(sel.cost)}   ${thousands(sel.requests)} 次   ${compact(sel.tokens)} tokens',
                        style: TextStyle(fontSize: 12, color: p.mutedFg),
                      ),
                    ],
                  ),
                ),
        ),
      ],
    );
  }
}

class _BarPainter extends CustomPainter {
  final List<double> values;
  final double top, step, axis, progress;
  final Color color, grid, label, highlight;
  final int? selected;
  final String Function(double) fmt;
  _BarPainter({
    required this.values,
    required this.top,
    required this.step,
    required this.axis,
    required this.color,
    required this.grid,
    required this.label,
    required this.highlight,
    required this.selected,
    required this.progress,
    required this.fmt,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final h = size.height;
    final gridPaint = Paint()
      ..color = grid
      ..strokeWidth = 1;
    // 横向网格线和纵轴刻度
    for (var v = 0.0; v <= top + step / 2; v += step) {
      final y = h - (v / top) * (h - 6);
      canvas.drawLine(Offset(axis, y), Offset(size.width, y), gridPaint);
      final tp = TextPainter(
        text: TextSpan(
          text: fmt(v),
          style: TextStyle(fontSize: 10, color: label),
        ),
        textDirection: TextDirection.ltr,
      )..layout();
      tp.paint(canvas, Offset(axis - 6 - tp.width, y - tp.height / 2));
    }
    final w = (size.width - axis) / values.length;
    final barW = (w - 4).clamp(2.0, 24.0);
    for (var i = 0; i < values.length; i++) {
      final x = axis + w * i;
      if (i == selected) canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(x, 0, w, h), const Radius.circular(6)), Paint()..color = highlight);
      final v = values[i];
      if (v <= 0) continue;
      final bh = ((v / top) * (h - 6) * progress).clamp(2.0, h);
      final rect = Rect.fromLTWH(x + (w - barW) / 2, h - bh, barW, bh);
      // 顶端 4px 圆角，底部贴着基线是直角
      canvas.drawRRect(RRect.fromRectAndCorners(rect, topLeft: const Radius.circular(4), topRight: const Radius.circular(4)), Paint()..color = color);
    }
  }

  @override
  bool shouldRepaint(_BarPainter old) => old.progress != progress || old.selected != selected || old.values != values;
}

class _UsageRowTile extends StatelessWidget {
  final CcUsageRow row;
  const _UsageRowTile({required this.row});

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final r = row;
    final speed = r.speed == null ? '—' : '${r.speedEstimated ? '≈' : ''}${r.speed!.round()} tok/s';
    final first = r.firstTokenMs == null ? '—' : '${r.firstTokenEstimated ? '≈' : ''}${(r.firstTokenMs! / 1000).toStringAsFixed(1)}s';
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: p.card,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: p.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  r.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontFamily: mono, fontSize: 13, fontWeight: FontWeight.w500),
                ),
              ),
              Text(usd(r.cost), style: const TextStyle(fontWeight: FontWeight.w600)),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            '${thousands(r.requests)} 次 · ${compact(r.tokens)} tokens · 成功 ${(r.successRate * 100).toStringAsFixed(r.successRate == 1 ? 0 : 1)}% · $speed · 首字 $first',
            style: TextStyle(fontSize: 12, color: p.mutedFg),
          ),
        ],
      ),
    );
  }
}

class _LogTile extends StatelessWidget {
  final CcLog log;
  const _LogTile({required this.log});

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final l = log;
    String two(int n) => n.toString().padLeft(2, '0');
    final t = l.at.toLocal();
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 44,
            child: Text(
              '${two(t.hour)}:${two(t.minute)}',
              style: TextStyle(fontSize: 12, color: p.mutedFg, fontFamily: mono),
            ),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  l.model,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontFamily: mono, fontSize: 12.5),
                ),
                Text(
                  '入 ${compact(l.input)} · 出 ${compact(l.output)} · 缓存 ${compact(l.cacheRead)}/${compact(l.cacheCreation)} · ${(l.latencyMs / 1000).toStringAsFixed(1)}s',
                  style: TextStyle(fontSize: 11.5, color: p.mutedFg),
                ),
              ],
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(usd(l.cost), style: const TextStyle(fontSize: 12.5)),
              if (l.status >= 400) Text('${l.status}', style: TextStyle(fontSize: 11, color: p.destructive)),
            ],
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// 供应商
// ---------------------------------------------------------------------------

const _category = {'official': '官方', 'cn_official': '国内官方', 'aggregator': '聚合', 'third_party': '第三方', 'custom': '自定义'};

class _ProvidersTab extends StatefulWidget {
  final CcApp app;
  final ValueChanged<CcStatus> onStatus;
  const _ProvidersTab({required this.app, required this.onStatus});

  @override
  State<_ProvidersTab> createState() => _ProvidersTabState();
}

class _ProvidersTabState extends State<_ProvidersTab> {
  String? _switching;

  Future<void> _pick(CcProvider pr) async {
    if (pr.current || _switching != null) return;
    HapticFeedback.selectionClick();
    setState(() => _switching = pr.id);
    final api = AppScope.read(context).api;
    final r = await run(context, () => api.ccSwitch(widget.app.app, pr.id));
    if (r != null && mounted) {
      final st = await run(context, api.ccStatus);
      if (st != null) widget.onStatus(st);
      if (mounted) toast(context, '${widget.app.label} 已切换到 ${pr.name}，之后新开的会话生效${r.launched ? '（已在后台启动 CC Switch）' : ''}');
    }
    if (mounted) setState(() => _switching = null);
  }

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    return ListView(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 32),
      children: [
        Text(
          '点一下切换，和在 CC Switch 里切换完全一样（由它完成），改的是电脑上的全局配置：之后新开的 ${widget.app.label} 会话生效。',
          style: TextStyle(fontSize: 12, color: p.mutedFg, height: 1.5),
        ),
        const SizedBox(height: 12),
        if (widget.app.providers.isEmpty)
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(border: Border.all(color: p.border), borderRadius: BorderRadius.circular(14)),
            child: Text(
              'CC Switch 里还没有给 ${widget.app.label} 添加供应商。请先在电脑上的 CC Switch 里选「${widget.app.label}」添加一个，添加后这里就能切换。',
              style: TextStyle(fontSize: 13, color: p.mutedFg, height: 1.5),
            ),
          ),
        for (final pr in widget.app.providers)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Material(
              color: pr.current ? p.accent : p.card,
              borderRadius: BorderRadius.circular(14),
              child: InkWell(
                borderRadius: BorderRadius.circular(14),
                onTap: () => _pick(pr),
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 200),
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: pr.current ? p.ring : p.border),
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Flexible(
                                  child: Text(
                                    pr.name,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w500),
                                  ),
                                ),
                                if (_category[pr.category] != null)
                                  Container(
                                    margin: const EdgeInsets.only(left: 8),
                                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                                    decoration: BoxDecoration(color: p.muted, borderRadius: BorderRadius.circular(5)),
                                    child: Text(_category[pr.category]!, style: TextStyle(fontSize: 10, color: p.mutedFg)),
                                  ),
                              ],
                            ),
                            if (pr.website != null)
                              Text(
                                Uri.tryParse(pr.website!)?.host ?? pr.website!,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(fontSize: 12, color: p.mutedFg),
                              ),
                          ],
                        ),
                      ),
                      AnimatedSwitcher(
                        duration: const Duration(milliseconds: 200),
                        child: _switching == pr.id
                            ? const SizedBox.square(key: ValueKey('spin'), dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
                            : pr.current
                            ? Row(
                                key: const ValueKey('on'),
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Icon(Icons.check_rounded, size: 18, color: p.fg),
                                  const SizedBox(width: 4),
                                  Text('使用中', style: TextStyle(fontSize: 12, color: p.mutedFg)),
                                ],
                              )
                            : Text(
                                key: const ValueKey('off'),
                                '切换',
                                style: TextStyle(fontSize: 12, color: p.mutedFg),
                              ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// MCP、Prompts、Skills：经调试端口在电脑上的 CC Switch 里操作
// ---------------------------------------------------------------------------

/// MCP / Skills 可以分别启用到哪些应用（与 CC Switch 的列一致）。
const _targetApps = [
  ('claude', 'Claude'),
  ('codex', 'Codex'),
  ('gemini', 'Gemini'),
  ('grokbuild', 'Grok'),
  ('opencode', 'OpenCode'),
  ('openclaw', 'OpenClaw'),
  ('hermes', 'Hermes'),
  ('pi', 'Pi'),
  ('mcode', 'MiniMax'),
  ('kimi', 'Kimi'),
  ('agy', 'Antigravity'),
];

/// 这些栏目要经调试端口操作 CC Switch；没开启时提示开启（会重启一下电脑上的 CC Switch）。
class _NeedsBridge extends StatefulWidget {
  final Widget child;
  const _NeedsBridge({required this.child});

  @override
  State<_NeedsBridge> createState() => _NeedsBridgeState();
}

class _NeedsBridgeState extends State<_NeedsBridge> {
  bool? _ok;
  bool _enabling = false;

  @override
  void initState() {
    super.initState();
    AppScope.read(context).api
        .ccBridgeAvailable()
        .then((v) => mounted ? setState(() => _ok = v) : null, onError: (_) => mounted ? setState(() => _ok = false) : null);
  }

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    if (_ok == true) return widget.child;
    if (_ok == null) return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              '这一栏要直接操作电脑上的 CC Switch，需要它开一个只监听本机的调试端口（开启时它会重启一下）。',
              textAlign: TextAlign.center,
              style: TextStyle(color: p.mutedFg),
            ),
            const SizedBox(height: 14),
            FilledButton(
              onPressed: _enabling
                  ? null
                  : () async {
                      setState(() => _enabling = true);
                      final r = await run(context, () => AppScope.read(context).api.ccEnableBridge().then((_) => true));
                      if (mounted) {
                        setState(() {
                          _enabling = false;
                          _ok = r == true;
                        });
                      }
                    },
              child: Text(_enabling ? '正在开启…' : '开启'),
            ),
          ],
        ),
      ),
    );
  }
}

/// 一排应用开关：点一下启用 / 停用。
class _AppChips extends StatelessWidget {
  final Map<String, dynamic> apps;
  final String? busy;
  final void Function(String app, bool enabled) onToggle;
  const _AppChips({required this.apps, required this.busy, required this.onToggle});

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    return Wrap(
      spacing: 6,
      runSpacing: 6,
      children: [
        for (final (app, label) in _targetApps)
          Builder(
            builder: (context) {
              final on = apps[app] == true;
              return AnimatedContainer(
                duration: const Duration(milliseconds: 180),
                decoration: BoxDecoration(
                  color: on ? p.fg : Colors.transparent,
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(color: on ? p.fg : p.border),
                ),
                child: InkWell(
                  borderRadius: BorderRadius.circular(20),
                  onTap: busy == app
                      ? null
                      : () {
                          HapticFeedback.selectionClick();
                          onToggle(app, !on);
                        },
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        if (busy == app)
                          Padding(
                            padding: const EdgeInsets.only(right: 4),
                            child: SizedBox.square(dimension: 10, child: CircularProgressIndicator(strokeWidth: 1.5, color: on ? p.bg : p.fg)),
                          )
                        else if (on)
                          Padding(
                            padding: const EdgeInsets.only(right: 3),
                            child: Icon(Icons.check_rounded, size: 13, color: p.bg),
                          ),
                        Text(label, style: TextStyle(fontSize: 12, color: on ? p.bg : p.mutedFg)),
                      ],
                    ),
                  ),
                ),
              );
            },
          ),
      ],
    );
  }
}

class _McpTab extends StatefulWidget {
  const _McpTab();

  @override
  State<_McpTab> createState() => _McpTabState();
}

class _McpTabState extends State<_McpTab> {
  List<Map<String, dynamic>>? _servers;
  String? _busy;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final r = await run(context, () => AppScope.read(context).api.ccInvoke('get_mcp_servers'));
    if (r is Map && mounted) setState(() => _servers = [for (final v in r.values) Map<String, dynamic>.from(v as Map)]);
  }

  Future<void> _toggle(Map<String, dynamic> s, String app, bool enabled) async {
    setState(() => _busy = '${s['id']}|$app');
    await run(context, () => AppScope.read(context).api.ccInvoke('set_mcp_enabled', {'app': app, 'id': s['id'], 'enabled': enabled}));
    await _load();
    if (mounted) setState(() => _busy = null);
  }

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final servers = _servers;
    if (servers == null) return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 32),
        children: [
          Text('点应用名启用或停用这个 MCP 服务器，CC Switch 会同步写进对应应用的配置。新增、编辑请在电脑上的完整界面里操作。', style: TextStyle(fontSize: 12, color: p.mutedFg, height: 1.5)),
          const SizedBox(height: 12),
          if (servers.isEmpty)
            Padding(
              padding: const EdgeInsets.all(24),
              child: Center(
                child: Text('还没有 MCP 服务器', style: TextStyle(color: p.mutedFg)),
              ),
            ),
          for (final s in servers)
            Builder(
              builder: (context) {
                final spec = Map<String, dynamic>.from(s['server'] as Map? ?? {});
                final cmd = spec['url'] ?? [spec['command'], ...((spec['args'] as List?) ?? [])].whereType<Object>().join(' ');
                final busy = _busy != null && _busy!.startsWith('${s['id']}|') ? _busy!.substring('${s['id']}|'.length) : null;
                return Container(
                  margin: const EdgeInsets.only(bottom: 10),
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: p.card,
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: p.border),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Flexible(
                            child: Text('${s['name']}', style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w500)),
                          ),
                          Container(
                            margin: const EdgeInsets.only(left: 8),
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                            decoration: BoxDecoration(color: p.muted, borderRadius: BorderRadius.circular(5)),
                            child: Text(
                              '${spec['type'] ?? 'stdio'}',
                              style: TextStyle(fontSize: 10, color: p.mutedFg, fontFamily: mono),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 2),
                      Text(
                        '$cmd',
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 11.5, color: p.mutedFg, fontFamily: mono),
                      ),
                      if (s['description'] != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: Text('${s['description']}', style: TextStyle(fontSize: 12, color: p.mutedFg)),
                        ),
                      const SizedBox(height: 10),
                      _AppChips(apps: Map<String, dynamic>.from(s['apps'] as Map? ?? {}), busy: busy, onToggle: (app, on) => _toggle(s, app, on)),
                    ],
                  ),
                );
              },
            ),
        ],
      ),
    );
  }
}

class _PromptsTab extends StatefulWidget {
  final List<CcApp> apps;
  const _PromptsTab({required this.apps});

  @override
  State<_PromptsTab> createState() => _PromptsTabState();
}

class _PromptsTabState extends State<_PromptsTab> {
  late String _app = widget.apps.isEmpty ? 'claude' : widget.apps.first.app;
  List<Map<String, dynamic>>? _prompts;
  String? _open;
  String? _busy;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _prompts = null);
    final r = await run(context, () => AppScope.read(context).api.ccInvoke('get_prompts', {'app': _app}));
    if (mounted) setState(() => _prompts = r is Map ? [for (final v in r.values) Map<String, dynamic>.from(v as Map)] : []);
  }

  Future<void> _enable(Map<String, dynamic> pr) async {
    setState(() => _busy = pr['id']);
    final ok = await run(
      context,
      () => AppScope.read(context).api.ccInvoke('enable_prompt', {'app': _app, 'id': pr['id']}).then((_) => true),
      success: '已启用「${pr['name']}」',
    );
    if (mounted) setState(() => _busy = null);
    if (ok == true) _load();
  }

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final options = {for (final a in widget.apps) a.app: a.label, 'hermes': 'Hermes'};
    final prompts = _prompts;
    return ListView(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 32),
      children: [
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: SegmentedSwitch(
            value: _app,
            options: options,
            onChanged: (v) {
              setState(() => _app = v);
              _load();
            },
          ),
        ),
        const SizedBox(height: 10),
        Text(
          '启用一个提示词，CC Switch 会把它写进这个应用的提示词文件（如 CLAUDE.md、AGENTS.md）。新增、编辑请在电脑上的完整界面里操作。',
          style: TextStyle(fontSize: 12, color: p.mutedFg, height: 1.5),
        ),
        const SizedBox(height: 12),
        if (prompts == null)
          const Padding(
            padding: EdgeInsets.all(24),
            child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
          )
        else if (prompts.isEmpty)
          Padding(
            padding: const EdgeInsets.all(24),
            child: Center(
              child: Text('这个应用还没有提示词', style: TextStyle(color: p.mutedFg)),
            ),
          )
        else
          for (final pr in prompts)
            Container(
              margin: const EdgeInsets.only(bottom: 8),
              decoration: BoxDecoration(
                color: pr['enabled'] == true ? p.accent : p.card,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: pr['enabled'] == true ? p.ring : p.border),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  InkWell(
                    borderRadius: BorderRadius.circular(14),
                    onTap: () => setState(() => _open = _open == pr['id'] ? null : pr['id']),
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(14, 12, 10, 12),
                      child: Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  '${pr['name']}',
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w500),
                                ),
                                if (pr['description'] != null)
                                  Text(
                                    '${pr['description']}',
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(fontSize: 12, color: p.mutedFg),
                                  ),
                              ],
                            ),
                          ),
                          if (pr['enabled'] == true)
                            Text('使用中', style: TextStyle(fontSize: 12, color: p.mutedFg))
                          else
                            OutlinedButton(onPressed: _busy == pr['id'] ? null : () => _enable(pr), child: Text(_busy == pr['id'] ? '启用中…' : '启用')),
                        ],
                      ),
                    ),
                  ),
                  AnimatedSize(
                    duration: const Duration(milliseconds: 200),
                    child: _open == pr['id']
                        ? Container(
                            constraints: const BoxConstraints(maxHeight: 320),
                            decoration: BoxDecoration(
                              border: Border(top: BorderSide(color: p.border)),
                            ),
                            child: SingleChildScrollView(
                              padding: const EdgeInsets.all(14),
                              child: SelectableText(
                                '${pr['content']}',
                                style: TextStyle(fontSize: 12, color: p.mutedFg, fontFamily: mono, height: 1.5),
                              ),
                            ),
                          )
                        : const SizedBox(width: double.infinity),
                  ),
                ],
              ),
            ),
      ],
    );
  }
}

class _SkillsTab extends StatefulWidget {
  const _SkillsTab();

  @override
  State<_SkillsTab> createState() => _SkillsTabState();
}

class _SkillsTabState extends State<_SkillsTab> {
  List<Map<String, dynamic>>? _skills;
  String? _busy;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final r = await run(context, () => AppScope.read(context).api.ccInvoke('get_installed_skills'));
    if (mounted) setState(() => _skills = r is List ? [for (final v in r) Map<String, dynamic>.from(v as Map)] : []);
  }

  Future<void> _toggle(Map<String, dynamic> s, String app, bool enabled) async {
    setState(() => _busy = '${s['id']}|$app');
    await run(context, () => AppScope.read(context).api.ccInvoke('toggle_skill_app', {'id': s['id'], 'app': app, 'enabled': enabled}));
    await _load();
    if (mounted) setState(() => _busy = null);
  }

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final skills = _skills;
    if (skills == null) return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 32),
        children: [
          Text('点应用名启用或停用这个 Skill。安装、更新、卸载请在电脑上的完整界面里操作。', style: TextStyle(fontSize: 12, color: p.mutedFg, height: 1.5)),
          const SizedBox(height: 12),
          if (skills.isEmpty)
            Padding(
              padding: const EdgeInsets.all(24),
              child: Center(
                child: Text('还没有通过 CC Switch 安装的 Skill', style: TextStyle(color: p.mutedFg)),
              ),
            ),
          for (final s in skills)
            Builder(
              builder: (context) {
                final busy = _busy != null && _busy!.startsWith('${s['id']}|') ? _busy!.substring('${s['id']}|'.length) : null;
                return Container(
                  margin: const EdgeInsets.only(bottom: 10),
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: p.card,
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: p.border),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('${s['name']}', style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w500)),
                      if (s['repoOwner'] != null)
                        Text(
                          '${s['repoOwner']}/${s['repoName'] ?? ''}',
                          style: TextStyle(fontSize: 11.5, color: p.mutedFg, fontFamily: mono),
                        ),
                      if (s['description'] != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: Text(
                            '${s['description']}',
                            maxLines: 3,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 12, color: p.mutedFg),
                          ),
                        ),
                      const SizedBox(height: 10),
                      _AppChips(apps: Map<String, dynamic>.from(s['apps'] as Map? ?? {}), busy: busy, onToggle: (app, on) => _toggle(s, app, on)),
                    ],
                  ),
                );
              },
            ),
        ],
      ),
    );
  }
}
