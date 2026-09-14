export function scheduleTiming(cron: string | null) {
  const fallback = { frequency: 'custom', time: '04:00', weekday: '0' };
  if (cron === '0 * * * *') return { ...fallback, frequency: 'hourly' };
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6])$/.exec(cron || '');
  if (!match || Number(match[1]) > 59 || Number(match[2]) > 23) return fallback;
  return {
    frequency: match[3] === '*' ? 'daily' : 'weekly',
    time: `${match[2]!.padStart(2, '0')}:${match[1]!.padStart(2, '0')}`,
    weekday: match[3] === '*' ? '0' : match[3]!,
  };
}

export function scheduleCron(frequency: string, time: string, weekday = '0') {
  if (frequency === 'hourly') return '0 * * * *';
  if (
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) ||
    !/^[0-6]$/.test(weekday) ||
    !['daily', 'weekly'].includes(frequency)
  )
    throw new Error('Choose a valid schedule time and day.');
  const [hour, minute] = time.split(':').map(Number);
  return `${minute} ${hour} * * ${frequency === 'weekly' ? weekday : '*'}`;
}

export function scheduleDescription(cron: string) {
  const { frequency, time, weekday } = scheduleTiming(cron);
  if (frequency === 'hourly') return 'Every hour, on the hour';
  if (frequency === 'daily') return `Every day at ${time}`;
  if (frequency === 'weekly') {
    const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
      Number(weekday)
    ];
    return `Every ${day} at ${time}`;
  }
  return `Custom: ${cron}`;
}
