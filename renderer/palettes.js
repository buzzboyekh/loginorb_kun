// 配色沿用《光與壑》的莫內色票：4 季 × 4 時段 = 16 組
// 主程序（選單）與畫面（小球）共用這份資料。

const SEASONS = [
  { id: 'spring', label: '春' },
  { id: 'summer', label: '夏' },
  { id: 'autumn', label: '秋' },
  { id: 'winter', label: '冬' },
];

const TIMES = [
  { id: 'morning', label: '早晨' },
  { id: 'noon', label: '中午' },
  { id: 'sunset', label: '日落' },
  { id: 'night', label: '夜晚' },
];

const COLORS = {
  spring: {
    morning: ['#F2D7EE', '#FFFACD', '#E0FFFF', '#FFB7C5', '#98FB98', '#E6E6FA'],
    noon: ['#B0E0E6', '#ADD8E6', '#87CEFA', '#F0F8FF', '#FFFFFF', '#F5F5F5'],
    sunset: ['#FFDAB9', '#EE82EE', '#FFB6C1', '#F0E68C', '#87CEFA', '#FFF0F5'],
    night: ['#B0C4DE', '#D8BFD8', '#6495ED', '#E6E6FA', '#778899', '#F8F8FF'],
  },
  summer: {
    morning: ['#E0FFFF', '#FFDEAD', '#F0FFF0', '#FFC0CB', '#00BFFF', '#FAFAD2'],
    noon: ['#AFEEEE', '#8FBC8F', '#FFFACD', '#FFB6C1', '#D8BFD8', '#E9967A'],
    sunset: ['#B0C4DE', '#D8BFD8', '#E6E6FA', '#C0C0C0', '#F0F8FF', '#ADD8E6'],
    night: ['#191970', '#2C3E50', '#483D8B', '#34495E', '#F0E68C', '#556B2F'],
  },
  autumn: {
    morning: ['#FFF8DC', '#FFDEAD', '#F5DEB3', '#FFE4C4', '#D2B48C', '#E6E6FA'],
    noon: ['#DAA520', '#DEB887', '#87CEEB', '#ADD8E6', '#F5DEB3', '#D2B48C'],
    sunset: ['#CD853F', '#A0522D', '#8B4513', '#D2691E', '#FF8C00', '#FFD700'],
    night: ['#3E2723', '#4F4F4F', '#706B62', '#8C867D', '#A9A9A9', '#DCDCDC'],
  },
  winter: {
    morning: ['#FFFAFA', '#F0FFFF', '#FFB6C1', '#E6E6FA', '#DCDCDC', '#FFF0F5'],
    noon: ['#FFFFFF', '#F8F8FF', '#E0FFFF', '#D8BFD8', '#B0E0E6', '#E6E6FA'],
    sunset: ['#B0C4DE', '#778899', '#C0C0C0', '#D8BFD8', '#87CEFA', '#FFB6C1'],
    night: ['#2F2F4F', '#3C3C5C', '#5D5D7D', '#778899', '#8E88A6', '#B0C4DE'],
  },
};

// 攤平成一維陣列，順序 = 春(早→夜)、夏、秋、冬，和原作品的流轉順序一致
const PALETTES = [];
for (const s of SEASONS) {
  for (const t of TIMES) {
    PALETTES.push({
      id: `${s.id}-${t.id}`,
      season: s.label,
      time: t.label,
      seasonId: s.id,
      timeId: t.id,
      colors: COLORS[s.id][t.id],
    });
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PALETTES, SEASONS, TIMES };
} else {
  window.PALETTES = PALETTES;
}
