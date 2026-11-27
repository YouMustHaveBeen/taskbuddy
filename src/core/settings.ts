export const defaults = {
  timezone: "Europe/Dublin",
  sessionTtlHours: 24 * 30,
  loginLinkTtlMinutes: 10,
  initDataMaxAgeMinutes: 60,
  tgUpdateRetentionHours: 24,
  referenceNameMaxLength: 100,
  rewardMinutes: 10,
  itemTitleMaxLength: 4096,
  itemTextMaxLength: 1000,
  itemMaxSpheres: 3,
  priorityWeights: { important: 2, impactful: 2, urgent: 1, easy: 1 },
  priorityLevels: { top: 5, high: 4, medium: 2, low: 1 },
  deadlineHorizonDays: 7,
  pickStaleDaysCap: 14,
  pickFrogBoost: 2,
  /** Сколько раз за день в слоте можно отказаться и получить замену. */
  refusalReplacements: 2,
  /** Сколько выполненных задач заполняет кольцо «Пять задач». */
  dayRingTasks: 5,
  /** Сколько дней хранится план дня; очистка в ночной задаче (этап 2а, часть 3). */
  dayPlanKeepDays: 30,
};
