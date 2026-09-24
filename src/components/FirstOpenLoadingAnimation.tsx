import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Text, View } from 'react-native';
import { StyleSheet } from '@/theme/StyleSheet';
import { hasSeenFirstOpenIntro, markFirstOpenIntroSeen } from '@/storage/firstOpenIntro';

type IntroPhase = 'checking' | 'animating' | 'hidden';

function Ingredient({
  symbol,
  progress,
  startX,
  startY,
  startRotation
}: {
  symbol: string;
  progress: Animated.Value;
  startX: number;
  startY: number;
  startRotation: number;
}) {
  return (
    <Animated.Text
      importantForAccessibility="no"
      style={[
        styles.ingredient,
        {
          opacity: progress.interpolate({
            inputRange: [0, 0.12, 0.82, 1],
            outputRange: [0, 1, 1, 0]
          }),
          transform: [
            {
              translateX: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [startX, 0]
              })
            },
            {
              translateY: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [startY, 10]
              })
            },
            {
              rotate: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [`${startRotation}deg`, '0deg']
              })
            },
            {
              scale: progress.interpolate({
                inputRange: [0, 0.7, 1],
                outputRange: [0.7, 1.08, 0.78]
              })
            }
          ]
        }
      ]}
    >
      {symbol}
    </Animated.Text>
  );
}

export function FirstOpenLoadingAnimation() {
  const [phase, setPhase] = useState<IntroPhase>('checking');
  const carrot = useRef(new Animated.Value(0)).current;
  const tomato = useRef(new Animated.Value(0)).current;
  const herb = useRef(new Animated.Value(0)).current;
  const bowlScale = useRef(new Animated.Value(0.95)).current;
  const whisk = useRef(new Animated.Value(0)).current;
  const sparkle = useRef(new Animated.Value(0)).current;
  const overlayOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    let cancelled = false;
    let animation: Animated.CompositeAnimation | null = null;

    const finish = () => {
      if (cancelled) return;
      void markFirstOpenIntroSeen().catch(() => {
        // If persistence is unavailable, the intro may appear again next launch.
      });
      setPhase('hidden');
    };

    void (async () => {
      let alreadySeen = false;
      try {
        alreadySeen = await hasSeenFirstOpenIntro();
      } catch {
        // Treat inaccessible storage as a fresh launch so the app still opens normally.
      }

      if (cancelled) return;
      if (alreadySeen) {
        setPhase('hidden');
        return;
      }

      setPhase('animating');

      let reduceMotion = false;
      try {
        reduceMotion = await AccessibilityInfo.isReduceMotionEnabled();
      } catch {
        // Use the regular animation when the preference cannot be read.
      }
      if (cancelled) return;

      if (reduceMotion) {
        carrot.setValue(0.74);
        tomato.setValue(0.74);
        herb.setValue(0.74);
        bowlScale.setValue(1);
        whisk.setValue(0.55);
        sparkle.setValue(1);

        animation = Animated.sequence([
          Animated.delay(550),
          Animated.timing(overlayOpacity, {
            toValue: 0,
            duration: 180,
            easing: Easing.out(Easing.quad),
            useNativeDriver: false
          })
        ]);
        animation.start(({ finished }) => {
          if (finished) finish();
        });
        return;
      }

      const drop = (value: Animated.Value, duration: number) =>
        Animated.timing(value, {
          toValue: 1,
          duration,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: false
        });

      animation = Animated.sequence([
        Animated.delay(90),
        Animated.stagger(105, [
          drop(carrot, 520),
          drop(tomato, 500),
          drop(herb, 480)
        ]),
        Animated.parallel([
          Animated.sequence([
            Animated.timing(bowlScale, {
              toValue: 1.07,
              duration: 150,
              easing: Easing.out(Easing.quad),
              useNativeDriver: false
            }),
            Animated.spring(bowlScale, {
              toValue: 1,
              speed: 22,
              bounciness: 7,
              useNativeDriver: false
            })
          ]),
          Animated.sequence([
            Animated.timing(whisk, {
              toValue: 1,
              duration: 180,
              easing: Easing.inOut(Easing.quad),
              useNativeDriver: false
            }),
            Animated.timing(whisk, {
              toValue: 0.18,
              duration: 160,
              easing: Easing.inOut(Easing.quad),
              useNativeDriver: false
            }),
            Animated.timing(whisk, {
              toValue: 0.78,
              duration: 150,
              easing: Easing.inOut(Easing.quad),
              useNativeDriver: false
            })
          ]),
          Animated.sequence([
            Animated.delay(120),
            Animated.timing(sparkle, {
              toValue: 1,
              duration: 240,
              easing: Easing.out(Easing.back(1.5)),
              useNativeDriver: false
            })
          ])
        ]),
        Animated.delay(260),
        Animated.timing(overlayOpacity, {
          toValue: 0,
          duration: 240,
          easing: Easing.out(Easing.quad),
          useNativeDriver: false
        })
      ]);

      animation.start(({ finished }) => {
        if (finished) finish();
      });
    })();

    return () => {
      cancelled = true;
      animation?.stop();
    };
  }, [bowlScale, carrot, herb, overlayOpacity, sparkle, tomato, whisk]);

  if (phase === 'hidden') return null;

  const whiskRotation = whisk.interpolate({
    inputRange: [0, 1],
    outputRange: ['-24deg', '24deg']
  });
  const sparkleScale = sparkle.interpolate({
    inputRange: [0, 1],
    outputRange: [0.35, 1]
  });

  return (
    <Animated.View
      accessibilityLabel="Creative Cooking is getting the kitchen ready"
      accessibilityRole="progressbar"
      accessibilityViewIsModal
      style={[styles.overlay, { opacity: overlayOpacity }]}
    >
      {phase === 'animating' ? (
        <View style={styles.content}>
          <View style={styles.stage}>
            <Text importantForAccessibility="no" style={[styles.sparkle, styles.sparkleLeft]}>
              ✦
            </Text>
            <Animated.Text
              importantForAccessibility="no"
              style={[
                styles.sparkle,
                styles.sparkleRight,
                { opacity: sparkle, transform: [{ scale: sparkleScale }, { rotate: '16deg' }] }
              ]}
            >
              ✦
            </Animated.Text>

            <View style={styles.ingredients}>
              <Ingredient symbol="🥕" progress={carrot} startX={-64} startY={-104} startRotation={-34} />
              <Ingredient symbol="🍅" progress={tomato} startX={58} startY={-118} startRotation={28} />
              <Ingredient symbol="🌿" progress={herb} startX={4} startY={-142} startRotation={18} />
            </View>

            <Animated.View style={[styles.bowlWrap, { transform: [{ scale: bowlScale }] }]}>
              <Animated.View
                importantForAccessibility="no"
                style={[styles.whisk, { transform: [{ rotate: whiskRotation }] }]}
              >
                <View style={styles.whiskHandle} />
                <View style={styles.whiskHead} />
              </Animated.View>
              <View style={styles.bowlRim} />
              <View style={styles.bowl}>
                <View style={styles.bowlHighlight} />
              </View>
            </Animated.View>
          </View>

          <Text style={styles.title}>Cooking up something creative</Text>
          <Text style={styles.subtitle}>A little of this, a little of that.</Text>
        </View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 1000,
    elevation: 1000,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff8ed'
  },
  content: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    transform: [{ translateY: -8 }]
  },
  stage: {
    width: 220,
    height: 205,
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginBottom: 16
  },
  ingredients: {
    position: 'absolute',
    top: 78,
    left: 110,
    alignItems: 'center',
    justifyContent: 'center'
  },
  ingredient: {
    position: 'absolute',
    fontSize: 38,
    lineHeight: 46
  },
  bowlWrap: {
    width: 150,
    height: 86,
    alignItems: 'center',
    justifyContent: 'flex-end'
  },
  bowlRim: {
    width: 126,
    height: 10,
    borderRadius: 8,
    backgroundColor: '#f59e0b',
    zIndex: 3,
    transform: [{ translateY: 4 }]
  },
  bowl: {
    width: 116,
    height: 58,
    borderBottomLeftRadius: 58,
    borderBottomRightRadius: 58,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    backgroundColor: '#172033',
    overflow: 'hidden'
  },
  bowlHighlight: {
    position: 'absolute',
    top: 10,
    left: 18,
    width: 46,
    height: 7,
    borderRadius: 8,
    backgroundColor: '#334155',
    transform: [{ rotate: '-8deg' }]
  },
  whisk: {
    position: 'absolute',
    top: 0,
    right: 17,
    width: 84,
    height: 64,
    zIndex: 2,
    transformOrigin: '62px 52px'
  },
  whiskHandle: {
    position: 'absolute',
    top: 5,
    right: 7,
    width: 66,
    height: 6,
    borderRadius: 4,
    backgroundColor: '#64748b',
    transform: [{ rotate: '-48deg' }]
  },
  whiskHead: {
    position: 'absolute',
    right: 49,
    bottom: 5,
    width: 22,
    height: 30,
    borderRadius: 12,
    borderWidth: 3,
    borderColor: '#94a3b8',
    transform: [{ rotate: '-48deg' }]
  },
  sparkle: {
    position: 'absolute',
    color: '#f59e0b',
    fontSize: 24,
    lineHeight: 28
  },
  sparkleLeft: {
    left: 24,
    top: 92,
    opacity: 0.45,
    transform: [{ rotate: '-14deg' }]
  },
  sparkleRight: {
    right: 22,
    top: 62
  },
  title: {
    color: '#172033',
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '800',
    textAlign: 'center',
    letterSpacing: -0.3
  },
  subtitle: {
    marginTop: 6,
    color: '#64748b',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center'
  }
});
