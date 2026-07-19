#!/usr/bin/env python3
import gzip
import json
import math
import pathlib
import statistics

TARGETS = {
    'sh-buddies-monitor', 'sh-buddies-persist', 'sh-buddies-ingest', 'sh-buddies-comments',
    'sh-minute-read-model', 'sh-track-metadata',
    'sh-pages-read-model', 'sh-monitor-maintenance',
    'sh-minute-ingest', 'sh-minute-derive', 'sh-minute-enrichment',
    'sh-minute-rebuild', 'sh-minute-maintenance', 'sh-monitor-other',
}
LEVEL_NAMES = {'level', 'severity', 'loglevel'}
OUTCOME_NAMES = {'outcome', 'status'}
ERROR_NAMES = {'error', 'exception', 'stack', 'stacktrace'}
OK_OUTCOMES = {'ok', 'success', 'succeeded', 'completed', 'true', '200'}
BAD_LEVELS = {'warn', 'warning', 'error', 'fatal', 'critical'}


def walk(value, prefix=''):
    if isinstance(value, dict):
        for key, child in value.items():
            name = f'{prefix}.{key}' if prefix else str(key)
            yield name, child
            yield from walk(child, name)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from walk(child, f'{prefix}[{index}]')


def event_metrics(event):
    cpu = []
    levels = []
    outcomes = []
    errors = []
    for path, value in walk(event):
        if value in (None, '', [], {}):
            continue
        leaf = path.rsplit('.', 1)[-1].lower()
        if 'cpu' in leaf and not isinstance(value, bool):
            try:
                number = float(value)
            except (TypeError, ValueError):
                pass
            else:
                if math.isfinite(number):
                    cpu.append(number)
        if leaf in LEVEL_NAMES:
            levels.append(str(value).lower())
        elif leaf in OUTCOME_NAMES:
            outcomes.append(str(value).lower())
        elif leaf in ERROR_NAMES:
            errors.append(str(value))
    flagged = (
        any(level in BAD_LEVELS for level in levels)
        or any(outcome not in OK_OUTCOMES for outcome in outcomes)
        or bool(errors)
    )
    return cpu, flagged


def percentile(items, fraction):
    if not items:
        return None
    ordered = sorted(items)
    return ordered[min(len(ordered) - 1, math.ceil(len(ordered) * fraction) - 1)]


def main():
    output_dir = pathlib.Path('observability-logs')
    output_dir.mkdir(parents=True, exist_ok=True)
    full_path = output_dir / 'sh-workers.ndjson'
    findings_path = output_dir / 'findings.ndjson'
    selection = json.loads(pathlib.Path('selection.json').read_text(encoding='utf-8'))
    counts = {name: 0 for name in sorted(TARGETS)}
    cpu = {name: [] for name in sorted(TARGETS)}
    findings = 0
    total = 0
    raw_paths = sorted(pathlib.Path('raw').glob('*'))

    with full_path.open('w', encoding='utf-8') as full, findings_path.open('w', encoding='utf-8') as flagged_file:
        for path in raw_paths:
            data = path.read_bytes()
            if data[:2] == b'\x1f\x8b':
                data = gzip.decompress(data)
            for line in data.decode('utf-8', errors='replace').splitlines():
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                script = event.get('ScriptName')
                if script not in TARGETS:
                    continue
                samples, flagged = event_metrics(event)
                compact = json.dumps(event, ensure_ascii=False, separators=(',', ':'))
                full.write(compact + '\n')
                total += 1
                counts[script] += 1
                cpu[script].extend(samples)
                if flagged:
                    flagged_file.write(compact + '\n')
                    findings += 1

    summary = {
        'ok': True,
        'since': selection['cutoff'],
        'objects_available': selection['objects_available'],
        'objects_selected': selection['objects_selected'],
        'objects_downloaded': len(raw_paths),
        'oldest_object_modified': selection['oldest_object_modified'],
        'newest_object_modified': selection['newest_object_modified'],
        'events': total,
        'findings': findings,
        'scripts': {},
    }
    for script in sorted(TARGETS):
        samples = cpu[script]
        summary['scripts'][script] = {
            'events': counts[script],
            'cpu_samples': len(samples),
            'cpu_avg': statistics.fmean(samples) if samples else None,
            'cpu_p95': percentile(samples, 0.95),
            'cpu_max': max(samples) if samples else None,
        }
    (output_dir / 'summary.json').write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + '\n',
        encoding='utf-8',
    )
    print(json.dumps(summary, ensure_ascii=False, separators=(',', ':')))


if __name__ == '__main__':
    main()
