/* Chart.js defaults + factory functions. Kept separate from app logic. */
(function () {
  'use strict';

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const C = {
    text: '#e8edf8', muted: '#8b96b0', faint: '#5f6a84',
    grid: 'rgba(255,255,255,0.05)',
    accent: '#6d8cff', accent2: '#22d3ee', violet: '#a78bfa',
    good: '#34d399', warn: '#fbbf24', hot: '#fb923c', bad: '#f87171',
  };

  if (window.Chart) {
    Chart.defaults.color = C.muted;
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.font.size = 11;
    Chart.defaults.borderColor = C.grid;
    Chart.defaults.animation.duration = 550;
    Chart.defaults.animation.easing = 'easeOutQuart';
    Chart.defaults.plugins.legend.display = false;
    Chart.defaults.plugins.tooltip = {
      ...Chart.defaults.plugins.tooltip,
      backgroundColor: 'rgba(11,16,28,.96)',
      borderColor: 'rgba(255,255,255,.12)',
      borderWidth: 1,
      titleColor: C.text,
      bodyColor: C.muted,
      padding: 10,
      cornerRadius: 8,
      displayColors: true,
      boxWidth: 8,
      boxHeight: 8,
      boxPadding: 4,
    };
  }

  /** Vertical gradient fill under a line. */
  function fill(ctx, area, hex, topAlpha = 0.28) {
    if (!area) return 'transparent';
    const g = ctx.createLinearGradient(0, area.top, 0, area.bottom);
    g.addColorStop(0, hexA(hex, topAlpha));
    g.addColorStop(1, hexA(hex, 0));
    return g;
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  const timeAxis = (unitHint) => ({
    type: 'category',
    grid: { display: false },
    border: { display: false },
    ticks: {
      maxRotation: 0, autoSkip: true, maxTicksLimit: unitHint || 7,
      color: C.faint, font: { size: 10 },
    },
  });

  const valueAxis = (extra = {}) => ({
    beginAtZero: true,
    grid: { color: C.grid, drawTicks: false },
    border: { display: false },
    ticks: { color: C.faint, font: { size: 10 }, padding: 8, maxTicksLimit: 6, ...(extra.ticks || {}) },
    ...extra,
  });

  const registry = new Map();

  function mount(id, config) {
    const el = document.getElementById(id);
    if (!el) return null;
    if (registry.has(id)) registry.get(id).destroy();
    const chart = new Chart(el.getContext('2d'), config);
    registry.set(id, chart);
    return chart;
  }

  window.Charts = {
    C, hexA, mount,

    growth(id, points) {
      const labels = points.map((p) => window.fmt.dateShort(p.t));
      return mount(id, {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: 'Group members',
              data: points.map((p) => p.total),
              borderColor: C.accent,
              backgroundColor: (c) => fill(c.chart.ctx, c.chart.chartArea, C.accent),
              borderWidth: 2, pointRadius: 0, pointHoverRadius: 4,
              fill: true, tension: 0.3,
            },
            {
              label: 'Tracked roster',
              data: points.map((p) => p.roster),
              borderColor: C.accent2,
              borderWidth: 1.5, borderDash: [4, 3],
              pointRadius: 0, pointHoverRadius: 4, fill: false, tension: 0.3,
            },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          scales: { x: timeAxis(6), y: valueAxis({ ticks: { callback: (v) => window.fmt.compact(v) } }) },
          plugins: { legend: { display: true, position: 'top', align: 'end', labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: 'circle', padding: 14 } } },
        },
      });
    },

    activity(id, series) {
      return mount(id, {
        type: 'bar',
        data: {
          labels: series.labels,
          datasets: [
            { label: 'Promotions', data: series.promotions, backgroundColor: C.good, borderRadius: 3, stack: 'a' },
            { label: 'Joins', data: series.joins, backgroundColor: C.accent, borderRadius: 3, stack: 'a' },
            { label: 'Departures', data: series.leaves.map((v) => -v), backgroundColor: hexA(C.bad, 0.8), borderRadius: 3, stack: 'a' },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          scales: {
            x: { ...timeAxis(6), stacked: true },
            y: { ...valueAxis({ ticks: { callback: (v) => Math.abs(v) } }), stacked: true, beginAtZero: true },
          },
          plugins: {
            legend: { display: true, position: 'top', align: 'end', labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: 'circle', padding: 12 } },
            tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${Math.abs(c.parsed.y)}` } },
          },
        },
      });
    },

    mix(id, entries) {
      const palette = {
        'on-track': C.good, due: C.warn, overdue: C.hot,
        stalled: C.bad, 'top-rank': C.violet, 'insufficient-data': '#4b5568',
      };
      return mount(id, {
        type: 'doughnut',
        data: {
          labels: entries.map((e) => window.fmt.statusLabel(e.status)),
          datasets: [{
            data: entries.map((e) => e.count),
            backgroundColor: entries.map((e) => palette[e.status] || C.faint),
            borderColor: 'rgba(7,10,18,.9)', borderWidth: 2, hoverOffset: 6,
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false, cutout: '64%',
          plugins: { tooltip: { callbacks: { label: (c) => ` ${c.label}: ${window.fmt.num(c.parsed)}` } } },
        },
      });
    },
  };
})();
