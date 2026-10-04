import { ChevronRight, FolderOpen, Trash2 } from 'lucide-react-native'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { KeyboardAvoidingView, ScrollView, StyleSheet, Switch, View } from 'react-native'

import {
  isValidSchedule,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  type AutomationSchedule
} from '../desktop'
import { pickFolder } from '../lib/folder-pick'
import { tildePath } from '../lib/format'
import type { ScreenProps } from '../nav'
import { api, errorText } from '../remote/api'
import { useData } from '../state/data'
import { makeStyles, radius, space, TOUCH, useTheme } from '../theme'
import {
  Button,
  confirm,
  Empty,
  Field,
  Mono,
  Pixel,
  Screen,
  SectionLabel,
  Segmented,
  Sheet,
  SheetAction,
  Tap,
  toast,
  Txt
} from '../ui'

type Kind = AutomationSchedule['kind']
type Unit = 'minutes' | 'hours'

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

const useStyles = makeStyles((t) => ({
  flex: { flex: 1 },
  content: { padding: space.lg, gap: space.lg, paddingBottom: space.xxl },
  prompt: { minHeight: 120, textAlignVertical: 'top' },
  card: {
    minHeight: TOUCH + 8,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.borderStrong,
    backgroundColor: t.surface,
    overflow: 'hidden'
  },
  cardRow: {
    minHeight: TOUCH + 8,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md
  },
  body: { flex: 1, minWidth: 0 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  number: { width: 96 },
  time: { width: 120 },
  gap: { gap: space.sm },
  save: { marginRight: space.sm },
  loading: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.lg }
}))

/** Create or edit an automation. */
export function AutomationEditScreen({ navigation, route }: ScreenProps<'AutomationEdit'>) {
  const styles = useStyles()
  const theme = useTheme()
  const id = route.params.id
  const projects = useData((s) => s.projects)
  const homeDir = useData((s) => s.appInfo?.homeDir)

  const [state, setState] = useState<'loading' | 'ready' | 'error'>(id ? 'loading' : 'ready')
  const [loadError, setLoadError] = useState('')
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [cwd, setCwd] = useState('')
  const [kind, setKind] = useState<Kind>('interval')
  const [amount, setAmount] = useState('1')
  const [unit, setUnit] = useState<Unit>('hours')
  const [time, setTime] = useState('09:00')
  const [weekdaysOnly, setWeekdaysOnly] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [saving, setSaving] = useState(false)
  const [projectSheet, setProjectSheet] = useState(false)

  const load = useCallback(() => {
    if (!id) {
      return
    }
    setState('loading')
    api.automations
      .list()
      .then((list) => {
        const found = list.find((a) => a.id === id)
        if (!found) {
          setLoadError('This automation no longer exists.')
          setState('error')
          return
        }
        setName(found.name)
        setPrompt(found.prompt)
        setCwd(found.cwd)
        setEnabled(found.enabled)
        setKind(found.schedule.kind)
        if (found.schedule.kind === 'interval') {
          const minutes = found.schedule.minutes
          const hours = minutes % 60 === 0
          setUnit(hours ? 'hours' : 'minutes')
          setAmount(String(hours ? minutes / 60 : minutes))
        } else {
          setTime(found.schedule.time)
          setWeekdaysOnly(!!found.schedule.weekdaysOnly)
        }
        setState('ready')
      })
      .catch((e: unknown) => {
        setLoadError(errorText(e))
        setState('error')
      })
  }, [id])

  useEffect(load, [load])

  const schedule = useMemo<AutomationSchedule>(() => {
    if (kind === 'daily') {
      return { kind: 'daily', time: time.trim(), ...(weekdaysOnly ? { weekdaysOnly: true } : {}) }
    }
    const n = /^\d+$/.test(amount.trim()) ? Number(amount.trim()) : NaN
    return { kind: 'interval', minutes: unit === 'hours' ? n * 60 : n }
  }, [kind, time, weekdaysOnly, amount, unit])

  const scheduleValid = isValidSchedule(schedule)
  const canSave = name.trim().length > 0 && prompt.trim().length > 0 && scheduleValid

  /** Bring a typed interval back inside what the desktop accepts. */
  const clampAmount = useCallback(() => {
    const n = Number(amount.trim())
    if (!Number.isFinite(n)) {
      return
    }
    const per = unit === 'hours' ? 60 : 1
    const minutes = Math.min(
      MAX_INTERVAL_MINUTES,
      Math.max(MIN_INTERVAL_MINUTES, Math.round(n) * per)
    )
    setAmount(String(Math.max(1, Math.round(minutes / per))))
  }, [amount, unit])

  const changeUnit = useCallback(
    (next: Unit) => {
      setUnit(next)
      const n = Number(amount.trim())
      if (Number.isFinite(n)) {
        const per = next === 'hours' ? 60 : 1
        const minutes = Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, n * per))
        setAmount(String(Math.max(1, Math.round(minutes / per))))
      }
    },
    [amount]
  )

  const save = useCallback(async () => {
    if (!canSave) {
      return
    }
    setSaving(true)
    try {
      await api.automations.save({
        ...(id ? { id } : {}),
        name: name.trim(),
        prompt: prompt.trim(),
        cwd,
        schedule,
        enabled
      })
      navigation.goBack()
    } catch (e) {
      toast(errorText(e))
      setSaving(false)
    }
  }, [canSave, id, name, prompt, cwd, schedule, enabled, navigation])

  const remove = useCallback(async () => {
    if (!id) {
      return
    }
    const sure = await confirm({
      title: `Delete "${name.trim() || 'this automation'}"?`,
      message: 'It stops running. Chats from earlier runs are kept.',
      action: 'Delete',
      danger: true
    })
    if (!sure) {
      return
    }
    try {
      await api.automations.delete(id)
      navigation.goBack()
    } catch (e) {
      toast(errorText(e))
    }
  }, [id, name, navigation])

  const chooseOther = useCallback(async () => {
    setProjectSheet(false)
    const path = await pickFolder(navigation, 'Choose a folder')
    if (path) {
      setCwd(path)
    }
  }, [navigation])

  const switchColors = {
    trackColor: { false: theme.borderStrong, true: theme.accent },
    thumbColor: theme.dark ? '#ececee' : '#ffffff'
  }

  const title = id ? 'Edit automation' : 'New automation'
  const back = () => navigation.goBack()

  if (state !== 'ready') {
    return (
      <Screen title={title} onBack={back}>
        {state === 'loading' ? (
          <View style={styles.loading}>
            <Pixel tone="working" />
            <Mono tone="muted">Loading…</Mono>
          </View>
        ) : (
          <Empty
            title="Could not load the automation"
            detail={loadError}
            action={<Button title="Retry" onPress={load} />}
          />
        )}
      </Screen>
    )
  }

  return (
    <Screen
      title={title}
      onBack={back}
      right={
        <Button
          title="Save"
          kind="primary"
          disabled={!canSave}
          busy={saving}
          onPress={() => void save()}
          style={styles.save}
        />
      }
    >
      <KeyboardAvoidingView behavior="padding" style={styles.flex}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <View>
            <SectionLabel>Name</SectionLabel>
            <Field
              value={name}
              onChangeText={setName}
              placeholder="Morning dependency check"
              accessibilityLabel="Name"
              maxLength={80}
              returnKeyType="next"
            />
          </View>

          <View>
            <SectionLabel>Prompt</SectionLabel>
            <Field
              value={prompt}
              onChangeText={setPrompt}
              placeholder="What pi should do on each run"
              accessibilityLabel="Prompt"
              multiline
              style={styles.prompt}
            />
          </View>

          <View>
            <SectionLabel>Project</SectionLabel>
            <View style={styles.card}>
              <Tap
                onPress={() => setProjectSheet(true)}
                accessibilityLabel={`Project: ${cwd ? tildePath(cwd, homeDir) : 'No project'}`}
                style={styles.cardRow}
              >
                <View style={styles.body}>
                  {cwd ? (
                    <Mono size={14} tone="text" numberOfLines={1} ellipsizeMode="head">
                      {tildePath(cwd, homeDir)}
                    </Mono>
                  ) : (
                    <Txt tone="text2">No project</Txt>
                  )}
                </View>
                <ChevronRight size={18} color={theme.muted} strokeWidth={1.75} />
              </Tap>
            </View>
          </View>

          <View style={styles.gap}>
            <SectionLabel style={{ marginBottom: 0 }}>Schedule</SectionLabel>
            <Segmented<Kind>
              value={kind}
              onChange={setKind}
              options={[
                { value: 'interval', label: 'Every…' },
                { value: 'daily', label: 'Daily at…' }
              ]}
            />
            {kind === 'interval' ? (
              <>
                <View style={styles.inline}>
                  <Field
                    value={amount}
                    onChangeText={(text) => setAmount(text.replace(/[^\d]/g, ''))}
                    onEndEditing={clampAmount}
                    keyboardType="number-pad"
                    maxLength={5}
                    accessibilityLabel="Interval"
                    style={styles.number}
                  />
                  <View style={styles.flex}>
                    <Segmented<Unit>
                      value={unit}
                      onChange={changeUnit}
                      options={[
                        { value: 'minutes', label: 'minutes' },
                        { value: 'hours', label: 'hours' }
                      ]}
                    />
                  </View>
                </View>
                <Mono size={12} tone={scheduleValid ? 'muted' : 'danger'}>
                  between {MIN_INTERVAL_MINUTES} minutes and {MAX_INTERVAL_MINUTES / 1440} days
                </Mono>
              </>
            ) : (
              <>
                <View style={styles.inline}>
                  <Field
                    value={time}
                    onChangeText={setTime}
                    placeholder="09:00"
                    keyboardType="numbers-and-punctuation"
                    maxLength={5}
                    accessibilityLabel="Time of day, hours and minutes"
                    style={styles.time}
                  />
                  <Mono size={12} tone={TIME_RE.test(time.trim()) ? 'muted' : 'danger'}>
                    24-hour HH:MM, the computer's time
                  </Mono>
                </View>
                <View style={styles.inline}>
                  <Txt style={styles.flex}>Weekdays only</Txt>
                  <Switch
                    value={weekdaysOnly}
                    onValueChange={setWeekdaysOnly}
                    accessibilityLabel="Weekdays only"
                    {...switchColors}
                  />
                </View>
              </>
            )}
          </View>

          <View style={styles.inline}>
            <View style={styles.body}>
              <Txt>Enabled</Txt>
              <Txt size="caption" tone="muted">
                Runs only while Pi Desktop is open on the computer.
              </Txt>
            </View>
            <Switch
              value={enabled}
              onValueChange={setEnabled}
              accessibilityLabel="Enabled"
              {...switchColors}
            />
          </View>

          {id ? (
            <Button
              title="Delete automation"
              kind="danger"
              icon={Trash2}
              onPress={() => void remove()}
            />
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>

      <Sheet visible={projectSheet} onClose={() => setProjectSheet(false)} title="Project">
        <SheetAction
          title="No project"
          selected={cwd === ''}
          onPress={() => {
            setCwd('')
            setProjectSheet(false)
          }}
        />
        {projects.map((project) => (
          <SheetAction
            key={project.cwd}
            title={project.name}
            detail={tildePath(project.cwd, homeDir)}
            selected={cwd === project.cwd}
            onPress={() => {
              setCwd(project.cwd)
              setProjectSheet(false)
            }}
          />
        ))}
        <SheetAction
          icon={FolderOpen}
          title="Choose another folder…"
          onPress={() => void chooseOther()}
        />
      </Sheet>
    </Screen>
  )
}
